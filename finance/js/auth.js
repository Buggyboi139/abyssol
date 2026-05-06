import { supabase, fetchUserProfile, fetchTransactions } from './api.js';
import { state } from './state.js';
import { hydrateUI, triggerCalculations, renderStatementList } from './ui.js';

let lastHandledUserId = null;

export async function initAuth() {
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('[DEBUG] onAuthStateChange fired — event:', event, '| session user:', session?.user?.id ?? 'none');
        try {
            await handleAuthChange(session);
        } catch (err) {
            console.error('[DEBUG] handleAuthChange threw an unhandled error:', err);
        }
    });

    document.getElementById('authForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('authEmail').value;
        const password = document.getElementById('authPassword').value;
        const btn = document.getElementById('authSubmitBtn');
        const isReg = btn.dataset.mode === 'register';
        btn.disabled = true;

        try {
            if (isReg) {
                const { error } = await supabase.auth.signUp({ email, password });
                if (error) throw error;
                alert('Registration successful. Check your email to confirm.');
            } else {
                const { error } = await supabase.auth.signInWithPassword({ email, password });
                if (error) throw error;
            }
        } catch (err) {
            const banner = document.getElementById('authErrorBanner');
            banner.textContent = err.message;
            banner.classList.add('visible');
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('authToggleBtn').addEventListener('click', (e) => {
        const btn = document.getElementById('authSubmitBtn');
        const isReg = btn.dataset.mode === 'register';
        btn.dataset.mode = isReg ? 'login' : 'register';
        btn.textContent = isReg ? 'Sign In' : 'Sign Up';
        e.target.textContent = isReg ? 'Create an account' : 'Already have an account? Sign in';
        document.getElementById('authErrorBanner').classList.remove('visible');
    });

    document.getElementById('signOutBtn').addEventListener('click', () => supabase.auth.signOut());
}

async function handleAuthChange(session) {
    const overlay = document.getElementById('auth-overlay');
    const wrapper = document.getElementById('appWrapper');

    if (!session) {
        state.user = null;
        state.profileLoaded = false;
        lastHandledUserId = null;
        overlay.classList.remove('hidden');
        wrapper.classList.add('hidden');
        return;
    }

    state.user = session.user;
    overlay.classList.add('hidden');
    wrapper.classList.remove('hidden');

    if (lastHandledUserId === session.user.id) return;
    lastHandledUserId = session.user.id;

    state.isHydrating = true;
    try {
        console.log('[DEBUG] handleAuthChange — fetching profile for user:', state.user.id);
        const { profile, isNewUser } = await fetchUserProfile(state.user.id);
        console.log('[DEBUG] fetchUserProfile result — profile:', profile, '| isNewUser:', isNewUser);

        state.transactions = await fetchTransactions(state.user.id);
        console.log('[DEBUG] state.transactions set — length:', state.transactions.length, '| sample[0]:', state.transactions[0] ?? 'empty');

        if (profile) {
            hydrateUI(profile);
        }
        state.profileLoaded = true;
        state.isNewUser = isNewUser;
        console.log('[DEBUG] calling triggerCalculations...');
        await triggerCalculations({ skipSave: isNewUser });
        console.log('[DEBUG] triggerCalculations completed successfully');
        renderStatementList();
    } catch (err) {
        console.error('[DEBUG] Error inside handleAuthChange try-block:', err);
    } finally {
        state.isHydrating = false;
    }
}
