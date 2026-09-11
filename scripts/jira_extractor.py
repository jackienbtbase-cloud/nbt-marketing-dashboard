import os
import requests
from requests.auth import HTTPBasicAuth
from supabase import create_client, Client
from dotenv import load_dotenv

load_dotenv()

JIRA_DOMAIN = os.getenv("JIRA_DOMAIN")  # e.g. "yourdomain.atlassian.net"
JIRA_EMAIL = os.getenv("JIRA_EMAIL")
JIRA_API_TOKEN = os.getenv("JIRA_API_TOKEN")
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def fetch_and_sync():
    url = f"https://{JIRA_DOMAIN}/rest/api/2/search/jql"
    auth = HTTPBasicAuth(JIRA_EMAIL, JIRA_API_TOKEN)
    headers = {
        "Accept": "application/json",
        "Content-Type": "application/json"
    }
    
    # Using POST requires sending the parameters as a JSON payload
    payload = {
        "jql": 'project = KAN ORDER BY created DESC',
        "expand": "changelog",
        "fields": ["*all"], 
        "maxResults": 100
    }

    print(f"Connecting to Jira via POST: {url}")
    response = requests.post(url, headers=headers, json=payload, auth=auth)
    # Replace response.raise_for_status() with this error catcher
    if not response.ok:
        print(f"Jira API Error {response.status_code}: {response.text}")
        return
    
    jira_data = response.json()
    issues = jira_data.get("issues", [])
    print(f"Jira returned {len(issues)} issues.")
    
    if len(issues) == 0:
        print("Raw Jira Response:", jira_data)
        return

    for issue in issues:
        key = issue["key"]
        fields = issue.get("fields", {})
        
        # 2. Extract directly from the standard fields array (API v2)
        comment_obj = fields.get("comment")
        comments_array = comment_obj.get("comments", []) if comment_obj else []
        
        latest_comment = "<i>No comments yet.</i>"
        if comments_array:
            # Grab the last item and convert line breaks to HTML
            raw_comment = comments_array[-1].get("body", "<i>No comments yet.</i>")
            latest_comment = raw_comment.replace("\n", "<br>")
        
        # 3. Add latest_comment to your Supabase upsert payload
        prospect_payload = {
            "issue_key": key,
            "summary": fields.get("summary", ""),
            "assignee": fields.get("assignee", {}).get("displayName", "Unassigned") if fields.get("assignee") else "Unassigned",
            "current_status": fields.get("status", {}).get("name", "") if fields.get("status") else "",
            "created_at": fields.get("created"),
            "latest_comment": latest_comment # NEW FIELD
        }
        
        supabase.table("nmmsb_prospects").upsert(prospect_payload).execute()
        print(f"Synced Prospect: {key}")

        histories = issue.get("changelog", {}).get("histories", [])
        for history in histories:
            created_date = history["created"]
            for item in history.get("items", []):
                if item.get("field") == "status":
                    transition_payload = {
                        "issue_key": key,
                        "from_status": item.get("fromString", "Created"),
                        "to_status": item.get("toString", ""),
                        "transitioned_at": created_date
                    }
                    supabase.table("nmmsb_transitions").upsert(
                        transition_payload, 
                        ignore_duplicates=True,
                        on_conflict="issue_key,to_status,transitioned_at"
                    ).execute()
    
    # 1. Create a list of all active issue keys we just pulled from Jira
    active_jira_keys = [issue["key"] for issue in issues]
    
    # 2. Fetch all existing issue keys currently stored in Supabase
    db_response = supabase.table("nmmsb_prospects").select("issue_key").execute()
    db_keys = [row["issue_key"] for row in db_response.data]
    
    # 3. Identify and delete any keys in Supabase that are no longer in Jira
    for db_key in db_keys:
        if db_key not in active_jira_keys:
            # Delete from transitions table first to wipe the history
            supabase.table("nmmsb_transitions").delete().eq("issue_key", db_key).execute()
            
            # Then delete the main prospect record
            supabase.table("nmmsb_prospects").delete().eq("issue_key", db_key).execute()
            
            print(f"Removed deleted Jira ticket and its history from database: {db_key}")
    
    print("Database sync complete.")

if __name__ == "__main__":
    fetch_and_sync()