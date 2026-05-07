Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

const charts = { history: null, donut: null, fire: null, bell: null, categoryDonut: null, merchant: null };

export function drawHistoryChart(labels, inflows, outflows) {
    const ctx = document.getElementById('historyChart')?.getContext('2d');
    if (!ctx) return;
    if (charts.history) {
        charts.history.data.labels = labels;
        charts.history.data.datasets[0].data = inflows;
        charts.history.data.datasets[1].data = outflows;
        charts.history.update();
        return;
    }
    charts.history = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                { type: 'line', label: 'Income', data: inflows, borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.3, yAxisID: 'y' },
                { type: 'bar', label: 'Spending', data: outflows, backgroundColor: '#fb7185', yAxisID: 'y' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false }
        }
    });
}

export function drawDonutChart(spending, remaining) {
    const ctx = document.getElementById('budgetDonutChart')?.getContext('2d');
    if (!ctx) return;
    if (charts.donut) {
        charts.donut.data.datasets[0].data = [spending, Math.max(0, remaining)];
        charts.donut.update();
        return;
    }
    charts.donut = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Spending', 'Remaining'],
            datasets: [{ data: [spending, Math.max(0, remaining)], backgroundColor: ['#fb7185', '#34d399'], borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { color: '#f8fafc' } } } }
    });
}

export function drawCategoryDonutChart(labels, data, colors) {
    const ctx = document.getElementById('categoryDonutChart')?.getContext('2d');
    if (!ctx) return;
    const CH_COLORS = ['#0ea5e9', '#8b5cf6', '#34d399', '#fb7185', '#f59e0b', '#6366f1', '#ec4899', '#94a3b8'];
    const bgColors = colors || labels.map((_, i) => CH_COLORS[i % CH_COLORS.length]);
    if (charts.categoryDonut) {
        charts.categoryDonut.data.labels = labels;
        charts.categoryDonut.data.datasets[0].data = data;
        charts.categoryDonut.data.datasets[0].backgroundColor = bgColors;
        charts.categoryDonut.update();
        return;
    }
    charts.categoryDonut = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{ data, backgroundColor: bgColors, borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'right', labels: { color: '#f8fafc' } } } }
    });
}

export function drawMerchantChart(labels, data) {
    const ctx = document.getElementById('merchantBarChart')?.getContext('2d');
    if (!ctx) return;
    if (charts.merchant) {
        charts.merchant.data.labels = labels;
        charts.merchant.data.datasets[0].data = data;
        charts.merchant.update();
        return;
    }
    charts.merchant = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{ label: 'Total Spending', data, backgroundColor: '#8b5cf6', borderRadius: 4 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, indexAxis: 'y',
            plugins: { legend: { display: false } }
        }
    });
}

export function drawFireChart(ages, balances, fiTarget) {
    const ctx = document.getElementById('fireChart')?.getContext('2d');
    if (!ctx) return;
    if (charts.fire) {
        charts.fire.data.labels = ages;
        charts.fire.data.datasets[0].data = balances;
        charts.fire.data.datasets[1].data = Array(ages.length).fill(fiTarget);
        charts.fire.update();
        return;
    }
    charts.fire = new Chart(ctx, {
        type: 'line',
        data: {
            labels: ages,
            datasets: [
                { label: 'Portfolio Value', data: balances, borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.1 },
                { label: 'Retirement Target', data: Array(ages.length).fill(fiTarget), borderColor: '#fb7185', borderDash: [5, 5], fill: false }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

export function drawBellCurve(percentile) {
    const ctx = document.getElementById('bellCurveChart')?.getContext('2d');
    if (!ctx) return;
    const xValues = [], yValues = [];
    for (let i = 0; i <= 100; i += 2) { xValues.push(i); yValues.push(Math.exp(-Math.pow(i - 50, 2) / (2 * Math.pow(15, 2)))); }
    const pointIndex = xValues.findIndex(x => x >= (100 - percentile));
    if (charts.bell) {
        charts.bell.data.datasets[1].data = xValues.map((x, i) => i === pointIndex ? yValues[i] : null);
        charts.bell.update();
        return;
    }
    charts.bell = new Chart(ctx, {
        type: 'line',
        data: {
            labels: xValues,
            datasets: [
                { label: 'Distribution', data: yValues, borderColor: 'rgba(59, 130, 246, 0.5)', backgroundColor: 'rgba(59, 130, 246, 0.1)', fill: true, pointRadius: 0 },
                { label: 'You', data: xValues.map((x, i) => i === pointIndex ? yValues[i] : null), borderColor: '#38bdf8', backgroundColor: '#38bdf8', pointRadius: 6 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { x: { display: false }, y: { display: false } }, plugins: { legend: { display: false } } }
    });
}

export function resizeCharts() {
    Object.values(charts).forEach(c => { if (c) c.resize(); });
}
