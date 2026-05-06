import { fetchMarketData } from './api.js';
import { state } from './state.js';
import { initAuth } from './auth.js';
import { triggerCalculations } from './ui.js';
import { resizeCharts } from './charts.js';

document.addEventListener("DOMContentLoaded", async () => {
    await fetchMarketData(state);
    initAuth();

    document.querySelectorAll('.tab-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-link').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById(e.target.getAttribute('data-tab')).classList.add('active');
            resizeCharts();
        });
    });

    const formInputs = document.querySelectorAll('#setupForm input, #setupForm select');
    formInputs.forEach(input => input.addEventListener('change', triggerCalculations));
    
    document.querySelectorAll('.expense-input').forEach(input => input.addEventListener('input', triggerCalculations));
    document.getElementById('spouseHousingContribution').addEventListener('input', triggerCalculations);
    document.getElementById('targetHomePrice').addEventListener('input', triggerCalculations);
    document.getElementById('downPayment').addEventListener('input', triggerCalculations);
    document.getElementById('spouseAutoContribution').addEventListener('input', triggerCalculations);
    document.getElementById('targetCarPrice').addEventListener('input', triggerCalculations);
    document.getElementById('fireContribution').addEventListener('input', triggerCalculations);
});