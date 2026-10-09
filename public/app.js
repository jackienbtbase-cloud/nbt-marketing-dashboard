const SUPABASE_URL = "https://yvtujoueyotncbvdlgyf.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inl2dHVqb3VleW90bmNidmRsZ3lmIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODI0MDE5NCwiZXhwIjoyMTAzODE2MTk0fQ.TSZ3CKJfKX7VsI5AdbiDPmYXRO9DhnkS-zbeNozMdvw";
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let chartInstance = null;

async function loadDashboardMetrics(days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - parseInt(days));

    const { data: transitions, error } = await supabaseClient
        .from('nmmsb_transitions')
        .select('*')
        .gte('transitioned_at', startDate.toISOString());

    if (error) {
        console.error("Error fetching metrics:", error);
        return;
    }

    processChartData(transitions);
}

function processChartData(transitions) {
    const statusCounts = {};

    transitions.forEach(t => {
        const status = t.to_status;
        statusCounts[status] = (statusCounts[status] || 0) + 1;
    });

    const labels = Object.keys(statusCounts);
    const counts = Object.values(statusCounts);

    document.getElementById('wonCount').innerText = statusCounts['CLOSED WON'] || 0;
    document.getElementById('lostCount').innerText = statusCounts['CLOSED LOST'] || 0;

    renderChart(labels, counts);
}

function renderChart(labels, dataPoints) {
    const ctx = document.getElementById('movementChart').getContext('2d');
    
    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Status Transitions (Selected Period)',
                data: dataPoints,
                backgroundColor: '#0052CC'
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: { beginAtZero: true }
            }
        }
    });
}

document.getElementById('periodSelect').addEventListener('change', (e) => {
    loadDashboardMetrics(e.target.value);
});


async function loadStagnantProspects() {
    // 1. Fetch all prospects and all transitions
    const { data: prospects, error: pError } = await supabaseClient.from('nmmsb_prospects').select('*');
    const { data: transitions, error: tError } = await supabaseClient.from('nmmsb_transitions').select('*');

    if (pError || tError) {
        console.error("Error fetching data for table:", pError || tError);
        return;
    }

    // 2. Filter out closed tickets
    const activeProspects = prospects.filter(p => {
        const status = p.current_status.toUpperCase();
        return status !== 'CLOSED WON' && status !== 'CLOSED LOST';
    });

    const now = new Date();
    const stagnantList = [];

    // 3. Calculate days since last transition
    activeProspects.forEach(prospect => {
        // Find all transitions for this specific ticket
        const issueTransitions = transitions.filter(t => t.issue_key === prospect.issue_key);
        
        // Default to the creation date if it has never moved
        let lastActionDate = new Date(prospect.created_at); 

        if (issueTransitions.length > 0) {
            // Sort to find the most recent transition
            issueTransitions.sort((a, b) => new Date(b.transitioned_at) - new Date(a.transitioned_at));
            lastActionDate = new Date(issueTransitions[0].transitioned_at);
        }

        const diffTime = Math.abs(now - lastActionDate);
        const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        if (diffDays > 5) {
            stagnantList.push({
                ...prospect,
                daysStagnant: diffDays
            });
        }
    });

    // 4. Sort by worst offenders (most days stagnant)
    stagnantList.sort((a, b) => b.daysStagnant - a.daysStagnant);
    renderStagnantTable(stagnantList);
}

function renderStagnantTable(list) {
    const tbody = document.getElementById('stagnantBody');
    tbody.innerHTML = '';

    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding: 24px; color: #5e6c84;">No stagnant prospects! Your pipeline is moving well. 🎉</td></tr>';
        return;
    }

    list.forEach(item => {
        // Dynamic heatmapping for management visibility
        let severityColor = '#ff991f'; // Warning Orange for > 5 days
        if (item.daysStagnant > 10) severityColor = '#de350b'; // Critical Red for > 30 days
        if (item.daysStagnant > 15) severityColor = '#bf2600'; // Dark Red for > 60 days

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong><a href="https://nbt-marketing.atlassian.net/browse/${item.issue_key}" target="_blank" style="color: #0052CC; text-decoration: none;">${item.issue_key}</a></strong></td>
            <td>${item.summary}</td>
            <td>${item.assignee}</td>
            <td><span class="status-badge">${item.current_status}</span></td>
            <td style="color: ${severityColor}; font-weight: bold;">${item.daysStagnant} Days</td>
            <td>
                <div style="display:flex; flex-direction:column; gap:6px;">
                    <span style="font-size:12px; color:#172b4d;">${item.latest_comment || '<i style="color:#5e6c84;">No comments yet</i>'}</span>
                    <div style="display:flex; gap:4px;">
                        <input type="text" id="comment-${item.issue_key}" placeholder="Write comment..." style="width: 140px; font-size: 12px; padding: 4px; border: 1px solid #dfe1e6; border-radius: 3px;">
                        <button onclick="submitComment('${item.issue_key}', '${item.current_status}')" style="padding: 4px 8px; cursor: pointer; font-size: 12px; background: #0052CC; color: white; border: none; border-radius: 3px;">Save</button>
                    </div>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Updated comment submission feature (Only Dihyauddin can reset) ---
window.submitComment = async function(issueKey, currentStatus) {
    const commentInput = document.getElementById(`comment-${issueKey}`).value;
    if (!commentInput) {
        alert("Please enter a comment before saving.");
        return;
    }

    // Prompt for user name to verify identity
    const userName = prompt("Please enter your name to verify identity (e.g. Dihyauddin):");
    if (!userName) return;

    const inputNameStr = userName.trim().toLowerCase();
    
    // Logic: Only Dihyauddin can reset the timer
    const canResetTime = inputNameStr === "dihyauddin";

    try {
        // 1. Anyone can comment, format it with their name
        const formattedComment = `${userName}: ${commentInput}`;
        const { error: commentError } = await supabaseClient
            .from('nmmsb_prospects')
            .update({ latest_comment: formattedComment })
            .eq('issue_key', issueKey);

        if (commentError) throw commentError;

        // 2. If Dihyauddin, insert transition record to reset the days
        if (canResetTime) {
            const { error: transitionError } = await supabaseClient
                .from('nmmsb_transitions')
                .insert([{
                    issue_key: issueKey,
                    to_status: currentStatus,
                    transitioned_at: new Date().toISOString()
                }]);
            
            if (transitionError) throw transitionError;
            alert(`✅ Comment saved! "Days Stagnant" timer has been RESET because Dihyauddin updated it.`);
        } else {
            alert(`✅ Comment saved!\n\n(Note: "Days Stagnant" is NOT reset because you are not Dihyauddin.)`);
        }

        // Reload and refresh the table
        loadStagnantProspects();
        
    } catch (error) {
        console.error("Error updating comment:", error);
        alert("Error saving comment. Please try again.");
    }
};

const JIRA_BASE_URL = "https://nbt-marketing.atlassian.net/browse/";

async function loadInteractivePipeline() {
    const { data: prospects, error } = await supabaseClient.from('nmmsb_prospects').select('*');
    
    if (error) {
        console.error("Error fetching prospects:", error);
        return;
    }

    const workflowStages = [
        "INITIATING", 
        "APPROACH", 
        "BRIEFING SESSION/ DEMO", 
        "SITE VISITS", 
        "BQ/ PROPOSAL PREPARATION", 
        "NEGOTIATION/ FOLLOW-UP",
        "CLOSED WON",
        "CLOSED LOST"
    ];

    const groupedTickets = {};
    workflowStages.forEach(stage => groupedTickets[stage] = []);

    prospects.forEach(ticket => {
        const status = ticket.current_status.toUpperCase();
        if (workflowStages.includes(status)) {
            groupedTickets[status].push(ticket);
        }
    });

    renderPipelineBlocks(groupedTickets);
}

function renderPipelineBlocks(groupedTickets) {
    const blocksContainer = document.getElementById('pipelineBlocks');
    blocksContainer.innerHTML = '';

    Object.keys(groupedTickets).forEach(status => {
        const ticketsInStage = groupedTickets[status];
        
        const block = document.createElement('div');
        block.className = 'status-block';
		
        if (status === 'CLOSED WON') block.style.background = '#00875A';
        if (status === 'CLOSED LOST') block.style.background = '#DE350B';
		
        block.innerHTML = `
            <span class="status-name">${status}</span>
            <span class="count">${ticketsInStage.length}</span>
        `;
        
        block.addEventListener('click', () => showTicketDetails(status, ticketsInStage));
        
        blocksContainer.appendChild(block);
    });
}

function showTicketDetails(status, tickets) {
    const container = document.getElementById('ticketDetailsContainer');
    const title = document.getElementById('selectedStatusTitle');
    const list = document.getElementById('ticketList');
    
    title.innerText = `${status} (${tickets.length} Prospects)`;
    list.innerHTML = '';

    if (tickets.length === 0) {
        list.innerHTML = '<p style="color: #5e6c84;">No active prospects in this stage.</p>';
    } else {
        tickets.forEach(ticket => {
            const card = document.createElement('div');
            card.className = 'ticket-card';
            
            card.innerHTML = `
                <div class="ticket-header" style="cursor: pointer;">
                    <div class="ticket-key">${ticket.issue_key}</div>
                    <div class="ticket-summary">${ticket.summary}</div>
                    <div class="ticket-assignee">Assigned to: ${ticket.assignee}</div>
                </div>
                <div class="ticket-comment" style="display: none; margin-top: 12px; padding-top: 12px; border-top: 1px solid #dfe1e6;">
                    <div style="font-size: 13px; color: #172b4d; margin-bottom: 12px; max-height: 150px; overflow-y: auto;">
                        <strong>Latest Update:</strong><br>
                        ${ticket.latest_comment || '<i>No comments yet.</i>'}
                    </div>
                    <a href="${JIRA_BASE_URL}${ticket.issue_key}" target="_blank" class="view-jira-btn">View more in Jira &rarr;</a>
                </div>
            `;
            
            const header = card.querySelector('.ticket-header');
            const commentSection = card.querySelector('.ticket-comment');
            
            header.addEventListener('click', () => {
                const isHidden = commentSection.style.display === 'none';
                commentSection.style.display = isHidden ? 'block' : 'none';
            });
            
            list.appendChild(card);
        });
    }
    container.style.display = 'block';
}

document.getElementById('closeDetailsBtn').addEventListener('click', () => {
    document.getElementById('ticketDetailsContainer').style.display = 'none';
});

loadInteractivePipeline();
loadDashboardMetrics(30);
loadStagnantProspects();
