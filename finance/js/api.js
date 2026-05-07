export const supabase = window.supabase.createClient(
    'https://agfngkzohlrmxjhysafn.supabase.co',
    'sb_publishable_8u_PB-tndXrjSe9TNu_G7A_GKQjBxD0'
);

export async function fetchMarketData(state) {
    try {
        const { data, error } = await supabase
            .from('macro_data')
            .select('*')
            .order('date', { ascending: false })
            .limit(1);
        if (error || !data || data.length === 0) return;
        const row = data[0];
        if (typeof row.fred_mortgage_30yr === 'number') state.marketRates.mortgage_30yr = row.fred_mortgage_30yr;
        if (typeof row.fred_auto_new === 'number') state.marketRates.auto_new = row.fred_auto_new;
        const inflationValue = row.fred_inflation_rate ?? row.fred_inflation;
        if (typeof inflationValue === 'number' && inflationValue > 0 && inflationValue < 25) {
            state.marketRates.inflation_cpi = inflationValue;
        }
    } catch (e) {
        console.warn('fetchMarketData failed, using fallback rates', e);
    }
}

export async function fetchLocationData(loc) {
    try {
        const res = await fetch(`data/${loc}.json`);
        if (!res.ok) return null;
        return await res.json();
    } catch (err) {
        return null;
    }
}

export async function fetchUserProfile(userId) {
    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
    if (error) {
        console.warn('fetchUserProfile error', error);
        return { profile: null, isNewUser: true, error };
    }
    return { profile: data, isNewUser: !data, error: null };
}

export async function saveUserProfile(userId, profileData) {
    const payload = { id: userId, ...profileData, updated_at: new Date() };
    const { error } = await supabase.from('profiles').upsert(payload);
    if (error) console.warn('saveUserProfile error', error);
    return error;
}

export async function fetchTransactions(userId) {
    const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('user_id', userId)
        .order('date', { ascending: false });
    if (error) {
        console.warn('fetchTransactions error', error);
        return [];
    }
    return data || [];
}

export async function listStatements(userId) {
    const { data, error } = await supabase.storage.from('statements').list(userId, {
        limit: 20,
        sortBy: { column: 'created_at', order: 'desc' }
    });
    if (error) {
        console.warn('listStatements error', error);
        return [];
    }
    return data || [];
}

export async function updateTransactionCategory(id, category) {
    const { error } = await supabase
        .from('transactions')
        .update({ category })
        .eq('id', id);
    if (error) console.warn('updateTransactionCategory error', error);
    return error;
}

export async function deleteTransaction(id) {
    const { error } = await supabase
        .from('transactions')
        .delete()
        .eq('id', id);
    if (error) console.warn('deleteTransaction error', error);
    return error;
}

export async function addTransaction(transaction) {
    const { data, error } = await supabase
        .from('transactions')
        .insert([transaction])
        .select();
    if (error) {
        console.warn('addTransaction error', error);
        return { data: null, error };
    }
    return { data, error: null };
}

export async function fetchBudgetLimits(userId) {
    const { data, error } = await supabase
        .from('budget_limits')
        .select('*')
        .eq('user_id', userId);
    if (error) {
        console.warn('fetchBudgetLimits error', error);
        return {};
    }
    const map = {};
    (data || []).forEach(row => { map[row.category] = row.monthly_limit; });
    return map;
}

export async function saveBudgetLimit(userId, category, monthlyLimit) {
    const { error } = await supabase
        .from('budget_limits')
        .upsert({ user_id: userId, category, monthly_limit: monthlyLimit, updated_at: new Date() });
    if (error) console.warn('saveBudgetLimit error', error);
    return error;
}

export async function recordCategorizationCorrection(userId, merchantName, oldCategory, newCategory) {
    const { error } = await supabase
        .from('categorization_corrections')
        .upsert({
            user_id: userId,
            merchant_name: merchantName,
            old_category: oldCategory,
            corrected_category: newCategory,
            created_at: new Date()
        }, { onConflict: 'user_id,merchant_name' });
    if (error) console.warn('recordCategorizationCorrection (non-critical):', error.message);
}
