Chart.defaults.color = '#94a3b8';
Chart.defaults.font.family = "'Plus Jakarta Sans', sans-serif";

const charts = { history: null, donut: null, fire: null, bell: null, categoryDonut: null, merchant: null, budgetBars: null, categoryTimeSeries: null, monthComparison: null, roth: null };

export function drawHistoryChart(labels, inflows, outflows, rollingAvg =[]) {
    const ctx = document.getElementById('historyChart')?.getContext('2d');
    if (!ctx) return;

    const baseDatasets =[
        { type: 'line', label: 'Income', data: inflows, borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.3, yAxisID: 'y' },
        { type: 'bar', label: 'Spending', data: outflows, backgroundColor: '#fb7185', yAxisID: 'y' },
    ];

    if (rollingAvg && rollingAvg.length > 0) {
        baseDatasets.push({
            type: 'line',
            label: '3-Month Avg Spend',
            data: rollingAvg,
            borderColor: '#f59e0b',
            backgroundColor: 'transparent',
            borderDash: [5, 5],
            fill: false,
            tension: 0,
            pointRadius: 0,
            yAxisID: 'y'
        });
    }

    if (charts.history) {
        charts.history.data.labels = labels;
        charts.history.data.datasets = baseDatasets;
        charts.history.update();
        return;
    }

    charts.history = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: baseDatasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
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
            datasets: [{ data:[spending, Math.max(0, remaining)], backgroundColor:['#fb7185', '#34d399'], borderWidth: 0 }]
        },
        options: { responsive: true, maintainAspectRatio: false, cutout: '70%', plugins: { legend: { position: 'bottom', labels: { color: '#f8fafc' } } } }
    });
}

export function drawCategoryDonutChart(labels, data, colors) {
    const ctx = document.getElementById('categoryDonutChart')?.getContext('2d');
    if (!ctx) return;
    const CH_COLORS =['#0ea5e9', '#8b5cf6', '#34d399', '#fb7185', '#f59e0b', '#6366f1', '#ec4899', '#94a3b8'];
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
            datasets:[{ label: 'Total Spending', data, backgroundColor: '#8b5cf6', borderRadius: 4 }]
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
            datasets:[
                { label: 'Portfolio Value', data: balances, borderColor: '#34d399', backgroundColor: 'rgba(52, 211, 153, 0.1)', fill: true, tension: 0.1 },
                { label: 'Retirement Target', data: Array(ages.length).fill(fiTarget), borderColor: '#fb7185', borderDash: [5, 5], fill: false }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false }
    });
}

export function drawRothChart(labels, principalData, growthData) {
    const ctx = document.getElementById('rothChart')?.getContext('2d');
    if (!ctx) return;
    if (charts.roth) {
        charts.roth.data.labels = labels;
        charts.roth.data.datasets[0].data = principalData;
        charts.roth.data.datasets[1].data = growthData;
        charts.roth.update();
        return;
    }
    charts.roth = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets:[
                { label: 'Principal', data: principalData, backgroundColor: '#38bdf8', stacked: true },
                { label: 'Growth', data: growthData, backgroundColor: '#34d399', stacked: true }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                y: { stacked: true, grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', callback: v => '$' + v.toLocaleString() } }
            },
            plugins: {
                legend: { labels: { color: '#f8fafc' } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                    }
                }
            }
        }
    });
}

export function drawBellCurve(percentile) {
    const ctx = document.getElementById('bellCurveChart')?.getContext('2d');
    if (!ctx) return;
    const xValues = [], yValues =[];
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
            datasets:[
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

export function drawBudgetBarsChart(categories, actuals, limits) {
    const ctx = document.getElementById('budgetBarsChart')?.getContext('2d');
    if (!ctx) return;

    const colors = actuals.map((actual, i) => {
        const limit = limits[i];
        if (limit > 0 && actual > limit) return '#fb7185';
        if (limit > 0 && (actual / limit) >= 0.8) return '#f59e0b';
        return '#34d399';
    });

    if (charts.budgetBars) {
        charts.budgetBars.data.labels = categories;
        charts.budgetBars.data.datasets[0].data = actuals;
        charts.budgetBars.data.datasets[0].backgroundColor = colors;
        if (charts.budgetBars.data.datasets[1]) {
            charts.budgetBars.data.datasets[1].data = limits;
        }
        charts.budgetBars.update();
        return;
    }

    const datasets =[
        { label: 'Spent', data: actuals, backgroundColor: colors, borderRadius: 4 }
    ];

    if (limits.some(l => l > 0)) {
        datasets.push({
            label: 'Budget Limit',
            data: limits,
            backgroundColor: 'rgba(255,255,255,0.08)',
            borderColor: 'rgba(255,255,255,0.2)',
            borderWidth: 1,
            borderRadius: 4,
        });
    }

    charts.budgetBars = new Chart(ctx, {
        type: 'bar',
        data: { labels: categories, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: limits.some(l => l > 0), labels: { color: '#f8fafc', boxWidth: 12 } },
                tooltip: {
                    callbacks: {
                        label: ctx => `$${ctx.parsed.x.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                    }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', callback: v => '$' + v.toLocaleString() } },
                y: { grid: { display: false }, ticks: { color: '#f8fafc' } }
            }
        }
    });
}
    
export function drawCategoryTimeSeriesChart(categoryMonthData, selectedCategories) {
    const ctx = document.getElementById('categoryTimeSeriesChart')?.getContext('2d');
    if (!ctx) return;

    const monthSet = new Set();
    selectedCategories.forEach(cat => {
        Object.keys(categoryMonthData[cat] || {}).forEach(m => monthSet.add(m));
    });
    const labels = Array.from(monthSet).sort();

    const CH_COLORS =['#f59e0b','#0ea5e9','#8b5cf6','#34d399','#fb7185','#6366f1','#ec4899','#38bdf8','#a78bfa','#4ade80','#fbbf24','#94a3b8'];

    const datasets = selectedCategories.map((cat, i) => {
        const color = CH_COLORS[i % CH_COLORS.length];
        return {
            label: cat,
            data: labels.map(m => categoryMonthData[cat]?.[m] || 0),
            borderColor: color,
            backgroundColor: color + '22',
            fill: false,
            tension: 0.3,
            pointRadius: 4,
            pointHoverRadius: 6,
        };
    });

    if (charts.categoryTimeSeries) {
        charts.categoryTimeSeries.data.labels = labels;
        charts.categoryTimeSeries.data.datasets = datasets;
        charts.categoryTimeSeries.update();
        return;
    }

    charts.categoryTimeSeries = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom', labels: { color: '#f8fafc', boxWidth: 12, padding: 16 } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                    }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8' } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', callback: v => '$' + v.toLocaleString() }
                }
            }
        }
    });
}

export function drawMonthComparisonChart(months, categoryTotals) {
    const ctx = document.getElementById('monthComparisonChart')?.getContext('2d');
    if (!ctx) return;

    const categories = Object.keys(categoryTotals).sort((a, b) => {
        const totA = months.reduce((s, m) => s + (categoryTotals[a][m] || 0), 0);
        const totB = months.reduce((s, m) => s + (categoryTotals[b][m] || 0), 0);
        return totB - totA;
    });

    const MONTH_COLORS =['#0ea5e9','#8b5cf6','#34d399','#fb7185','#f59e0b','#6366f1'];

    const datasets = months.map((month, i) => ({
        label: new Date(month + '-01').toLocaleString('default', { month: 'short', year: '2-digit' }),
        data: categories.map(cat => categoryTotals[cat]?.[month] || 0),
        backgroundColor: MONTH_COLORS[i % MONTH_COLORS.length],
        borderRadius: 4,
    }));

    if (charts.monthComparison) {
        charts.monthComparison.data.labels = categories;
        charts.monthComparison.data.datasets = datasets;
        charts.monthComparison.update();
        return;
    }

    charts.monthComparison = new Chart(ctx, {
        type: 'bar',
        data: { labels: categories, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { position: 'bottom', labels: { color: '#f8fafc', boxWidth: 12 } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: $${ctx.parsed.y.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
                    }
                }
            },
            scales: {
                x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#94a3b8', maxRotation: 30 } },
                y: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#94a3b8', callback: v => '$' + v.toLocaleString() }
                }
            }
        }
    });
}