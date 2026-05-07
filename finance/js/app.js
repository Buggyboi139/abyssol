import { fetchMarketData, fetchTransactions, supabase, updateTransactionCategory, deleteTransaction, addTransaction, recordCategorizationCorrection } from './api.js';
import { state } from './state.js';
import { initAuth } from './auth.js';
import { triggerCalculations, renderStatementList, buildCategorySelectHTML } from './ui.js';
import { resizeCharts, drawCategoryTimeSeriesChart, drawMonthComparisonChart } from './charts.js';
import { filterTransactions, getPreProcessingSummary, groupTransactionsByCategoryAndMonth, calculateRollingAverage } from './calculators.js';
import { FLAT_CATEGORIES, PARENT_CATEGORIES } from './categories.js';

function populateCategoryFilters() {
    const filterCat = document.getElementById('filterCategory');
    if (filterCat) {
        filterCat.innerHTML = buildCategorySelectHTML('all', true);
    }
    const newTxCat = document.getElementById('newTxCategory');
    if (newTxCat) {
        newTxCat.innerHTML = buildCategorySelectHTML('Uncategorized', false);
    }
}

function switchView(view) {
    state.activeView = view;
    document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));

    ['chartContainerTimeline','chartContainerCategory','chartContainerMerchant','chartContainerTrends','chartContainerCompare'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.classList.remove('active-pane'); el.classList.add('hidden-pane'); }
    });

    const titleEl = document.getElementById('trendsHeaderTitle');

    if (view === 'timeline') {
        document.getElementById('viewTimelineBtn')?.classList.add('active');
        document.getElementById('chartContainerTimeline')?.classList.replace('hidden-pane', 'active-pane');
        if (titleEl) titleEl.textContent = 'Income & Spending Over Time';
    } else if (view === 'category') {
        document.getElementById('viewCategoryBtn')?.classList.add('active');
        document.getElementById('chartContainerCategory')?.classList.replace('hidden-pane', 'active-pane');
        if (titleEl) titleEl.textContent = 'Spending by Category';
    } else if (view === 'merchant') {
        document.getElementById('viewMerchantBtn')?.classList.add('active');
        document.getElementById('chartContainerMerchant')?.classList.replace('hidden-pane', 'active-pane');
        if (titleEl) titleEl.textContent = 'Top Merchants';
    } else if (view === 'trends') {
        document.getElementById('viewTrendsBtn')?.classList.add('active');
        document.getElementById('chartContainerTrends')?.classList.replace('hidden-pane', 'active-pane');
        if (titleEl) titleEl.textContent = 'Spending Trends by Category';
        renderTrendsView();
    } else if (view === 'compare') {
        document.getElementById('viewCompareBtn')?.classList.add('active');
        document.getElementById('chartContainerCompare')?.classList.replace('hidden-pane', 'active-pane');
        if (titleEl) titleEl.textContent = 'Month-over-Month Comparison';
        renderCompareView();
    }

    triggerCalculations();
    setTimeout(resizeCharts, 50);
}

function renderTrendsView() {
    const filtered = filterTransactions(state.transactions, { dateRange: '365', category: 'all' });
    const categoryMonthData = groupTransactionsByCategoryAndMonth(filtered);

    const filterContainer = document.getElementById('trendsCategoryFilter');
    if (filterContainer && !filterContainer.dataset.initialized) {
        filterContainer.dataset.initialized = 'true';
        const availableCats = Object.keys(categoryMonthData).sort();
        const topCats = availableCats
            .map(cat => ({ cat, total: Object.values(categoryMonthData[cat]).reduce((s,v) => s+v, 0) }))
            .sort((a,b) => b.total - a.total)
            .slice(0, 5)
            .map(x => x.cat);

        filterContainer.innerHTML = availableCats.map(cat => `
            <label style="display:flex; align-items:center; gap:6px; font-size:0.8rem; color:var(--text-muted); cursor:pointer; background:rgba(255,255,255,0.05); padding:4px 10px; border-radius:20px;">
                <input type="checkbox" class="trends-cat-check" value="${cat}" ${topCats.includes(cat) ? 'checked' : ''} style="accent-color:#38bdf8;">
                ${cat}
            </label>
        `).join('');

        filterContainer.addEventListener('change', () => renderTrendsView());
    }

    const checked = Array.from(document.querySelectorAll('.trends-cat-check:checked')).map(cb => cb.value);
    const selected = checked.length > 0 ? checked : Object.keys(categoryMonthData).slice(0, 5);

    if (typeof drawCategoryTimeSeriesChart === 'function') {
        drawCategoryTimeSeriesChart(categoryMonthData, selected);
    }
}

function renderCompareView() {
    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    const filtered = filterTransactions(state.transactions, { dateRange: '365', category: 'all' });
    const categoryMonthData = groupTransactionsByCategoryAndMonth(filtered);

    const activeMonths = months.filter(m =>
        Object.values(categoryMonthData).some(catData => catData[m])
    );

    if (activeMonths.length === 0) return;

    if (typeof drawMonthComparisonChart === 'function') {
        drawMonthComparisonChart(activeMonths, categoryMonthData);
    }
}

function buildMerchantMemory(transactions, limit = 40) {
    const merchantVotes = {};
    transactions.forEach(t => {
        if (t.type === 'income' || Number(t.amount) > 0) return;
        const merchant = (t.clean_merchant || t.description || '').trim();
        const cat = t.category || 'Uncategorized';
        if (!merchant || merchant.length < 2) return;
        if (!merchantVotes[merchant]) merchantVotes[merchant] = {};
        merchantVotes[merchant][cat] = (merchantVotes[merchant][cat] || 0) + 1;
    });

    const merchantMap = {};
    Object.entries(merchantVotes).forEach(([merchant, votes]) => {
        const topCat = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topCat && topCat !== 'Uncategorized') merchantMap[merchant] = topCat;
    });

    const sorted = Object.entries(merchantMap)
        .sort((a, b) => {
            const aTotal = Object.values(merchantVotes[a[0]]).reduce((s, v) => s + v, 0);
            const bTotal = Object.values(merchantVotes[b[0]]).reduce((s, v) => s + v, 0);
            return bTotal - aTotal;
        })
        .slice(0, limit);

    if (sorted.length === 0) return '';
    return '\n\nKNOWN MERCHANT MAPPINGS (use these exact categories for these merchants):\n' +
        sorted.map(([m, c]) => `- "${m}" → ${c}`).join('\n');
}

function setUploadStep(stepId, status) {
    const stepEl = document.getElementById(stepId);
    if (!stepEl) return;
    stepEl.className = 'upload-step' + (status !== 'pending' ? ` step-${status}` : '');
    const icon = stepEl.querySelector('.step-icon');
    if (icon) {
        icon.textContent = status === 'done' ? '✅' : status === 'error' ? '❌' : status === 'active' ? '🔄' : '⏳';
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    await fetchMarketData(state);
    populateCategoryFilters();
    initAuth();

    document.querySelectorAll('.menu-link').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.menu-link').forEach(l => l.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById(e.target.getAttribute('data-tab')).classList.add('active');
            document.getElementById('hamburgerMenu').classList.add('hidden');
            resizeCharts();
        });
    });

    document.getElementById('hamburgerBtn')?.addEventListener('click', () => {
        document.getElementById('hamburgerMenu').classList.remove('hidden');
    });
    document.getElementById('closeMenuBtn')?.addEventListener('click', () => {
        document.getElementById('hamburgerMenu').classList.add('hidden');
    });

    document.getElementById('profileBtn')?.addEventListener('click', () => {
        document.getElementById('profileModal').classList.remove('hidden');
    });
    document.getElementById('closeProfileBtn')?.addEventListener('click', () => {
        document.getElementById('profileModal').classList.add('hidden');
    });

    const formInputs = document.querySelectorAll('#setupForm input, #setupForm select');
    formInputs.forEach(input => input.addEventListener('change', () => triggerCalculations()));

    document.getElementById('targetHomePrice')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('downPayment')?.addEventListener('input', () => triggerCalculations());
    document.getElementById('loanType')?.addEventListener('change', () => triggerCalculations());
    document.getElementById('vaTaxExempt')?.addEventListener('change', () => triggerCalculations());
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
    document.getElementById('filterConfidence')?.addEventListener('change', (e) => {
        state.filters.confidence = e.target.value;
        triggerCalculations();
    });

    document.getElementById('viewTimelineBtn')?.addEventListener('click', () => switchView('timeline'));
    document.getElementById('viewCategoryBtn')?.addEventListener('click', () => switchView('category'));
    document.getElementById('viewMerchantBtn')?.addEventListener('click', () => switchView('merchant'));
    document.getElementById('viewTrendsBtn')?.addEventListener('click', () => switchView('trends'));
    document.getElementById('viewCompareBtn')?.addEventListener('click', () => switchView('compare'));

    document.getElementById('historicalLedger')?.addEventListener('change', async (e) => {
        if (e.target.classList.contains('category-select')) {
            const id = e.target.getAttribute('data-id');
            const newCat = e.target.value;
            const tx = state.transactions.find(t => t.id === id);
            if (tx) {
                const oldCat = tx.category;
                const merchantName = (tx.clean_merchant || tx.description || '').trim();
                tx.category = newCat;
                triggerCalculations();
                updateTransactionCategory(id, newCat).catch(err => console.error('Failed to update category', err));
                if (state.user && merchantName) {
                    recordCategorizationCorrection(state.user.id, merchantName, oldCat, newCat)
                        .catch(() => {});
                }
            }
        }
    });

    document.getElementById('historicalLedger')?.addEventListener('click', async (e) => {
        if (e.target.classList.contains('delete-tx-btn')) {
            const id = e.target.getAttribute('data-id');
            state.transactions = state.transactions.filter(t => t.id !== id);
            triggerCalculations();
            deleteTransaction(id).catch(err => console.error('Failed to delete transaction', err));
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
            category: type === 'income' ? 'Income' : category
        };

        const optimisticTx = { ...newTx, id: 'temp-' + Date.now() };
        state.transactions.unshift(optimisticTx);
        state.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
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
            outputEl.innerHTML = '<span style="color:#38bdf8;">Generating your personalized spending analysis...</span>';

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
            outputEl.innerHTML = data.result || 'Analysis complete.';
            outputEl.style.color = '#f8fafc';
        } catch (err) {
            outputEl.innerHTML = `<span class="text-danger">Could not generate insights: ${err.message}</span>`;
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
            btn.innerHTML = '✨ Working...';
            btn.disabled = true;
            outputEl.classList.remove('hidden');
            outputEl.innerHTML = 'Reviewing your spending against recommended guidelines...';

            const payload = {
                income: state.income,
                transactions: state.transactions
            };

            const { data, error } = await supabase.functions.invoke('ai-advisor', {
                body: { profile: payload, task: 'optimize-budget' }
            });

            if (error) throw error;
            outputEl.innerHTML = data.result || 'Review complete.';
        } catch (err) {
            outputEl.innerHTML = `<span class="text-danger">Error: ${err.message}</span>`;
            outputEl.style.color = '#fb7185';
        } finally {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    });

    document.getElementById('statementUpload')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !state.user) return;
        const statusEl = document.getElementById('uploadStatus');
        const stepsEl = document.getElementById('uploadProgressSteps');
        let currentStep = 'stepUpload';

        ['stepUpload', 'stepProcess', 'stepSave'].forEach(s => setUploadStep(s, 'pending'));
        stepsEl?.classList.remove('hidden-element');
        if (statusEl) { statusEl.textContent = ''; statusEl.style.color = 'var(--text-muted)'; }

        try {
            let mimeType = file.type;
            if (file.name.toLowerCase().endsWith('.csv')) mimeType = 'text/csv';

            currentStep = 'stepUpload';
            setUploadStep('stepUpload', 'active');
            const filePath = `${state.user.id}/${Date.now()}_${file.name}`;
            const { error: uploadError } = await supabase.storage.from('statements').upload(filePath, file);
            if (uploadError) throw new Error('Upload failed: ' + uploadError.message);
            setUploadStep('stepUpload', 'done');

            currentStep = 'stepProcess';
            setUploadStep('stepProcess', 'active');

            const categoryList = FLAT_CATEGORIES.join(', ');
            const promptEnhancement = `CRITICAL RULES FOR TRANSACTION NORMALIZATION:
1. Determine direction by context. "Payroll", "Deposit", "Refund" = income. Stores, payments, withdrawals = expense.
2. ALL income MUST be positive. ALL expenses MUST be negative.
3. Add a "type" field: exactly "income" or "expense".
4. Add a "confidence" field: a number 0.0–1.0 representing how certain you are of the category.
5. Category MUST be one of these exact strings: ${categoryList}.
6. Use the most specific subcategory possible (e.g. "Food & Dining > Groceries" rather than just "Food & Dining").`;

            const merchantMemory = buildMerchantMemory(state.transactions);
            const fullPrompt = promptEnhancement + merchantMemory;

            const { data, error: funcError } = await supabase.functions.invoke('process-statement', {
                body: { filePath, mimeType, userId: state.user.id, prompt: fullPrompt }
            });

            if (funcError) throw new Error(funcError.message);
            if (data?.error) throw new Error(data.error);
            setUploadStep('stepProcess', 'done');

            currentStep = 'stepSave';
            setUploadStep('stepSave', 'active');

            let transactions = Array.isArray(data?.transactions)
                ? data.transactions
                : JSON.parse((data?.result || '[]').replace(/```json/gi, '').replace(/```/g, '').trim());

            transactions = transactions.map(t => {
                let amt = parseFloat(t.amount) || 0;
                let desc = (t.clean_merchant || t.description || '').toLowerCase();
                let isIncome = false;
                if (t.type === 'income') isIncome = true;
                else if (t.type === 'expense') isIncome = false;
                else if (desc.includes('payroll') || desc.includes('deposit') || desc.includes('refund')) isIncome = true;
                else isIncome = amt > 0;

                return {
                    ...t,
                    user_id: state.user.id,
                    type: isIncome ? 'income' : 'expense',
                    amount: isIncome ? Math.abs(amt) : -Math.abs(amt),
                    category: t.category || 'Uncategorized',
                    confidence: typeof t.confidence === 'number' ? t.confidence : null
                };
            });

            const existingSet = new Set(
                state.transactions.map(t =>
                    `${t.date}|${Math.round(Math.abs(Number(t.amount)) * 100)}|${(t.clean_merchant || t.description || '').toLowerCase().trim().substring(0, 30)}`
                )
            );

            const newTransactions = transactions.filter(t => {
                const key = `${t.date}|${Math.round(Math.abs(Number(t.amount)) * 100)}|${(t.clean_merchant || t.description || '').toLowerCase().trim().substring(0, 30)}`;
                return !existingSet.has(key);
            });

            const skipped = transactions.length - newTransactions.length;

            if (newTransactions.length > 0) {
                const { error: insertError } = await supabase.from('transactions').insert(newTransactions);
                if (insertError) throw insertError;
            }

            setUploadStep('stepSave', 'done');

            const msg = `Done! ${newTransactions.length} transaction${newTransactions.length !== 1 ? 's' : ''} imported${skipped > 0 ? ` · ${skipped} duplicate${skipped > 1 ? 's' : ''} skipped` : ''}.`;
            if (statusEl) { statusEl.textContent = msg; statusEl.style.color = '#34d399'; }

            state.transactions = await fetchTransactions(state.user.id);
            triggerCalculations();
            renderStatementList();
        } catch (err) {
            setUploadStep(currentStep, 'error');
            if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#fb7185'; }
        } finally {
            e.target.value = '';
            setTimeout(() => {
                stepsEl?.classList.add('hidden-element');
                ['stepUpload', 'stepProcess', 'stepSave'].forEach(s => setUploadStep(s, 'pending'));
            }, 4000);
        }
    });

    const dropzone = document.getElementById('uploadDropzone');
    if (dropzone) {
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = '#38bdf8';
            dropzone.style.background = 'rgba(56, 189, 248, 0.08)';
        });
        dropzone.addEventListener('dragleave', () => {
            dropzone.style.borderColor = '';
            dropzone.style.background = '';
        });
        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.style.borderColor = '';
            dropzone.style.background = '';
            const file = e.dataTransfer.files[0];
            if (!file) return;
            const uploadInput = document.getElementById('statementUpload');
            if (uploadInput) {
                const dt = new DataTransfer();
                dt.items.add(file);
                uploadInput.files = dt.files;
                uploadInput.dispatchEvent(new Event('change'));
            }
        });
    }
});
