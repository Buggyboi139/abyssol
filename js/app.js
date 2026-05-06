import { fetchMarketData, fetchTransactions, supabase } from './api.js';
import { state } from './state.js';
import { initAuth } from './auth.js';
import { triggerCalculations, renderStatementList } from './ui.js';
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
    document.getElementById('geoCompare').addEventListener('change', triggerCalculations);

    document.getElementById('statementUpload').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !state.user) return;
        const statusEl = document.getElementById('uploadStatus');
        
        try {
            statusEl.textContent = "Uploading document to secure storage...";
            statusEl.style.color = "#60a5fa";

            let mimeType = file.type;
            if (file.name.endsWith('.csv')) mimeType = 'text/csv';
            
            const filePath = `${state.user.id}/${Date.now()}_${file.name}`;
            const { error: uploadError } = await supabase.storage.from('statements').upload(filePath, file);
            if (uploadError) throw new Error("Storage upload failed: " + uploadError.message);

            statusEl.textContent = "Sending to Edge Function for AI processing...";
            const { data, error: funcError } = await supabase.functions.invoke('process-statement', {
                body: { filePath, mimeType }
            });

            if (funcError) throw new Error(funcError.message);
            if (data.error) throw new Error(data.error);

            statusEl.textContent = "Saving transactions to database...";
            let transactions = JSON.parse(data.result.replace(/```json/gi, '').replace(/```/g, '').trim());
            transactions = transactions.map(t => ({ ...t, user_id: state.user.id }));

            const { error: insertError } = await supabase.from('transactions').insert(transactions);
            if (insertError) throw insertError;

            statusEl.textContent = `Success! ${transactions.length} transactions categorized and synced.`;
            statusEl.style.color = "#34d399";
            
            state.transactions = await fetchTransactions(state.user.id);
            triggerCalculations();
            renderStatementList();
            
        } catch (err) {
            statusEl.textContent = "Error: " + err.message;
            statusEl.style.color = "#fb7185";
        } finally {
            e.target.value = '';
        }
    });

    supabase.auth.onAuthStateChange((event, session) => {
        if (session) {
            setTimeout(renderStatementList, 1000);
        }
    });
});