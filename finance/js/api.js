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
        if (typeof row.fred_mortgage_30yr === 'number') {
            state.marketRates.mortgage_30yr = row.fred_mortgage_30yr;
        }
        if (typeof row.fred_auto_new === 'number') {
            state.marketRates.auto_new = row.fred_auto_new;
        }
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
    return data ||[];
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
    return data ||[];
}

export async function updateTransactionCategory(id, category) {
    const { error } = await supabase
        .from('transactions')
        .update({ category })
        .eq('id', id);
    if (error) console.warn('updateTransactionCategory error', error);
    return error;
}