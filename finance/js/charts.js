Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

const charts = { history: null, donut: null, fire: null, bell: null, categoryDonut: null };

export function drawHistoryChart(labels, inflows, outflows) {
    if (charts.history) charts.history.destroy();
    const ctx = document.getElementById('historyChart')?.getContext('2d');
    if (!ctx) return;
    charts.history = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets:[
                { label: 'Inflow', data: inflows, backgroundColor: '#34d399' },
                { label: 'Outflow', data: outflows, backgroundColor: '#fb7185' }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

export function drawDonutChart(personal, shared, savings) {
    if (charts.donut) charts.donut.destroy();
    const ctx = document.getElementById('budgetDonutChart')?.getContext('2d');
    if (!ctx) return;
    charts.donut = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels:['Personal Discretionary', 'Shared Obligation', 'Savings/Debt'],
            datasets: [{ data: [personal, shared, savings], backgroundColor:['#0ea5e9', '#8b5cf6', '#34d399'], borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { color: '#f8fafc' } } } }
    });
}

export function drawCategoryDonutChart(labels, data) {
    if (charts.categoryDonut) charts.categoryDonut.destroy();
    const ctx = document.getElementById('categoryDonutChart')?.getContext('2d');
    if (!ctx) return;
    const colors =['#0ea5e9', '#8b5cf6', '#34d399', '#fb7185', '#f59e0b', '#6366f1', '#ec4899', '#94a3b8'];
    charts.categoryDonut = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: labels.map((_, i) => colors[i % colors.length]), borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right', labels: { color: '#f8fafc' } } } }
    });
}

export function drawFireChart(ages, balances, fiTarget) {
    if (charts.fire) charts.fire.destroy();
    const ctx = document.getElementById('fireChart')?.getContext('2d');
    if (!ctx) return;
    charts.fire = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ages,
            datasets:[
                { label: 'Portfolio', data: balances, borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.1 },
                { label: 'FI Target', data: Array(ages.length).fill(fiTarget), borderColor: '#fb7185', borderDash:[5, 5], fill: false }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

export function drawBellCurve(percentile) {
    if (charts.bell) charts.bell.destroy();
    const ctx = document.getElementById('bellCurveChart')?.getContext('2d');
    if (!ctx) return;
    const xValues = [], yValues =[];
    for (let i = 0; i <= 100; i += 2) { xValues.push(i); yValues.push(Math.exp(-Math.pow(i - 50, 2) / (2 * Math.pow(15, 2)))); }
    const pointIndex = xValues.findIndex(x => x >= (100 - percentile));
    charts.bell = new Chart(ctx, {
        type: 'line',
        data: {
            labels: xValues,
            datasets:[
                { label: 'Distribution', data: yValues, borderColor: 'rgba(59, 130, 246, 0.5)', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, pointRadius: 0 },
                { label: 'You', data: xValues.map((x, i) => i === pointIndex ? yValues[i] : null), borderColor: '#38bdf8', backgroundColor: '#38bdf8', pointRadius: 6 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { display: false } }, plugins: { legend: { display: false } } }
    });
}

export function resizeCharts() {
    Object.values(charts).forEach(c => { if(c) c.resize(); });
}