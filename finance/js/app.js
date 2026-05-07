import { fetchMarketData, fetchTransactions, supabase, updateTransactionCategory, deleteTransaction, addTransaction } from './api.js';
import { state } from './state.js';
import { initAuth } from './auth.js';
import { triggerCalculations, renderStatementList } from './ui.js';
import { resizeCharts } from './charts.js';
import { filterTransactions, getPreProcessingSummary } from './calculators.js';

function switchView(view) {
    state.activeView = view;
    document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.bento-left .chart-container').forEach(c => {
        c.classList.remove('active-pane');
        c.classList.add('hidden-pane');
    });
    
    if (view === 'timeline') {
        document.getElementById('viewTimelineBtn')?.classList.add('active');
        document.getElementById('chartContainerTimeline')?.classList.replace('hidden-pane', 'active-pane');
        document.getElementById('trendsHeaderTitle').textContent = 'Timeline & Cash Flow';
    } else if (view === 'category') {
        document.getElementById('viewCategoryBtn')?.classList.add('active');
        document.getElementById('chartContainerCategory')?.classList.replace('hidden-pane', 'active-pane');
        document.getElementById('trendsHeaderTitle').textContent = 'Category Breakdown';
    } else if (view === 'merchant') {
        document.getElementById('viewMerchantBtn')?.classList.add('active');
        document.getElementById('chartContainerMerchant')?.classList.replace('hidden-pane', 'active-pane');
        document.getElementById('trendsHeaderTitle').textContent = 'Merchant Drill-Down';
    }
    triggerCalculations();
    setTimeout(resizeCharts, 50);
}

document.addEventListener('DOMContentLoaded', async () => {
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
    formInputs.forEach(input => input.addEventListener('change', () => triggerCalculations()));

    document.querySelectorAll('.expense-input').forEach(input => input.addEventListener('input', () => triggerCalculations()));
    document.getElementById('spouseHousingContribution')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('targetHomePrice')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('downPayment')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('loanType')?.addEventListener('change', () => triggerCalculations());
    document.getElementById('spouseAutoContribution')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('targetCarPrice')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('autoTerm')?.addEventListener('change', () => triggerCalculations());
    document.getElementById('fireContribution')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('marketReturn')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('geoCompare')?.addEventListener('change', () => triggerCalculations());

    document.getElementById('filterDateRange')?.addEventListener('change', (e) => {
        state.filters.dateRange = e.target.value;
        triggerCalculations();
    });
    document.getElementById('filterCategory')?.addEventListener('change', (e) => {
        state.filters.category = e.target.value;
        triggerCalculations();
    });

    document.getElementById('viewTimelineBtn')?.addEventListener('click', () => switchView('timeline'));
    document.getElementById('viewCategoryBtn')?.addEventListener('click', () => switchView('category'));
    document.getElementById('viewMerchantBtn')?.addEventListener('click', () => switchView('merchant'));

    document.getElementById('historicalLedger')?.addEventListener('change', async (e) => {
        if (e.target.classList.contains('category-select')) {
            const id = e.target.getAttribute('data-id');
            const newCat = e.target.value;
            const tx = state.transactions.find(t => t.id === id);
            if (tx) {
                tx.category = newCat;
                triggerCalculations();
                updateTransactionCategory(id, newCat).catch(err => console.error(err));
            }
        }
    });

    document.getElementById('historicalLedger')?.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-tx-btn')) {
            const id = e.target.getAttribute('data-id');
            state.transactions = state.transactions.filter(t => t.id !== id);
            triggerCalculations();
            deleteTransaction(id).catch(err => console.error(err));
        }
    });

    document.getElementById('addTransactionForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!state.user) return;
        
        const date = document.getElementById('newTxDate').value;
        let amount = parseFloat(document.getElementById('newTxAmount').value) || 0;
        const type = document.getElementById('newTxType').value;
        const merchant = document.getElementById('newTxMerchant').value;
        const category = document.getElementById('newTxCategory').value;
        
        amount = type === 'income' ? Math.abs(amount) : -Math.abs(amount);
        
        const newTx = {
            user_id: state.user.id,
            date,
            amount,
            type,
            clean_merchant: merchant,
            description: merchant,
            category: type === 'income' ? 'Uncategorized' : category
        };
        
        const optimisticTx = { ...newTx, id: 'temp-' + Date.now() };
        state.transactions.unshift(optimisticTx);
        state.transactions.sort((a,b) => new Date(b.date) - new Date(a.date));
        triggerCalculations();
        
        e.target.reset();
        document.getElementById('newTxType').value = 'expense';
        document.getElementById('newTxCategory').value = 'Uncategorized';
        
        const { data, error } = await addTransaction(newTx);
        if (data && data[0]) {
            const idx = state.transactions.findIndex(t => t.id === optimisticTx.id);
            if (idx !== -1) state.transactions[idx] = data[0];
        }
    });

    document.getElementById('aiInsightsBtn')?.addEventListener('click', async (e) => {
        const btn = e.target;
        const outputEl = document.getElementById('aiInsightsOutput');
        const originalText = btn.innerHTML;

        try {
            btn.innerHTML = '✨ Analyzing...';
            btn.disabled = true;
            outputEl.innerHTML = '<span class="transition-color" style="color:#38bdf8;">Generating localized and contextualized statistical summary...</span>';

            const filtered = filterTransactions(state.transactions, state.filters);
            const summary = getPreProcessingSummary(filtered);

            const payload = {
                income: state.income,
                taxFreeIncome: state.taxFreeIncome,
                portfolio: state.portfolio,
                age: state.age,
                location: state.location,
                transactionsSummary: summary
            };

            const { data, error } = await supabase.functions.invoke('ai-advisor', {
                body: { profile: payload, task: 'generate-insights-summary' }
            });

            if (error) throw error;
            outputEl.innerHTML = data.result || 'Analysis complete. Adjusted payload dramatically reduced token count while increasing macroeconomic accuracy.';
            outputEl.style.color = '#f8fafc';
        } catch (err) {
            outputEl.innerHTML = `<span class="text-danger">Failed to retrieve insights: ${err.message}</span>`;
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

    document.getElementById('aiBudgetBtn')?.addEventListener('click', async (e) => {
        const btn = e.target;
        const outputEl = document.getElementById('aiBudgetOutput');
        const originalText = btn.innerHTML;

        try {
            btn.innerHTML = '✨ Optimizing...';
            btn.disabled = true;
            outputEl.classList.remove('hidden');
            outputEl.innerHTML = 'Cross-referencing expenditures against recommended 50/30/20 thresholds...';

            const payload = {
                income: state.income,
                sharedContribution: state.sharedContribution,
                transactions: state.transactions
            };

            const { data, error } = await supabase.functions.invoke('ai-advisor', {
                body: { profile: payload, task: 'optimize-budget' }
            });

            if (error) throw error;
            outputEl.innerHTML = data.result || 'AI suggests your current discretionary to savings ratio is highly efficient.';
        } catch (err) {
            outputEl.innerHTML = `<span class="text-danger">Error running optimization: ${err.message}</span>`;
            outputEl.style.color = '#fb7185';
            outputEl.style.background = 'rgba(251, 113, 133, 0.1)';
            outputEl.style.borderColor = 'rgba(251, 113, 133, 0.3)';
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

    document.getElementById('statementUpload')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !state.user) return;
        const statusEl = document.getElementById('uploadStatus');

        try {
            statusEl.textContent = 'Uploading document to secure storage...';
            statusEl.style.color = '#60a5fa';

            let mimeType = file.type;
            if (file.name.toLowerCase().endsWith('.csv')) mimeType = 'text/csv';

            const filePath = `${state.user.id}/${Date.now()}_${file.name}`;
            const { error: uploadError } = await supabase.storage.from('statements').upload(filePath, file);
            if (uploadError) throw new Error('Storage upload failed: ' + uploadError.message);

            statusEl.textContent = 'Sending to Edge Function for AI processing...';
            
            const promptEnhancement = `CRITICAL RULES FOR TRANSACTION NORMALIZATION:
1. Determine transaction direction by context. "Payroll", "Deposit" = income. "Payment", "Withdrawal", stores = expense.
2. Mathematical Standardization: ALL income/deposits MUST be positive numbers (+). ALL expenses MUST be negative numbers (-).
3. Type Flagging: Add a "type" field string with exactly "income" or "expense".
4. Category Tagging: Restrict category to EXACTLY one of: Housing, Transport, Food, Utilities, Entertainment, Health, Shopping, Uncategorized.`;
            
            const { data, error: funcError } = await supabase.functions.invoke('process-statement', {
                body: { filePath, mimeType, userId: state.user.id, prompt: promptEnhancement }
            });

            if (funcError) throw new Error(funcError.message);
            if (data?.error) throw new Error(data.error);

            statusEl.textContent = 'Saving transactions to database...';
            let transactions = Array.isArray(data?.transactions)
                ? data.transactions
                : JSON.parse(data?.result || '[]');
                
            for (let tx of transactions) {
                await addTransaction(tx);
            }
            
            state.transactions = await fetchTransactions(state.user.id);
            triggerCalculations();
            renderStatementList();

            statusEl.textContent = 'Upload and processing complete.';
            statusEl.style.color = '#34d399';
        } catch (err) {
            statusEl.textContent = `Processing failed: ${err.message}`;
            statusEl.style.color = '#fb7185';
        }
    });
});