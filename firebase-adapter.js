/* Firebase adapter for "רשימת גריטה".
   Gives the app the same small interface it used inside Claude (window.claude.use(...)):
   db (Firestore), user (Firebase Auth), downloads (normal browser download).
   Also draws the sign-in screen (Google or e-mail + password). */
(function () {
  'use strict';
  window.STANDALONE = true;
  const cfg = window.APP_CONFIG || {};
  const fbc = cfg.firebase || {};
  const configured = !!(window.firebase && fbc.apiKey && fbc.projectId && !/PASTE|הדבק/.test(fbc.apiKey));
  const gClientId = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(cfg.googleClientId || '') ? cfg.googleClientId : '';

  /* ---------- downloads: a plain browser download ---------- */
  const downloads = {
    save: async ({ filename, data }) => {
      if (!filename || data == null) throw { code: 'bad_request', message: 'missing file' };
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = String(filename).slice(0, 200); a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: 'saved' };
    }
  };

  if (!configured) {
    // Not set up yet: the app still works on this device only, and shows how to finish setup.
    window.claude = { use: async (n) => (n === 'downloads' ? downloads : null) };
    document.addEventListener('DOMContentLoaded', () => {
      const b = document.createElement('div');
      b.className = 'setupbar';
      b.textContent = 'האפליקציה עוד לא חוברה ל-Firebase, ולכן הרשימה נשמרת רק במכשיר הזה. כדי לחבר: הדבק את firebaseConfig בקובץ config.js (ראה README).';
      document.body.prepend(b);
    });
    return;
  }

  firebase.initializeApp(fbc);
  const auth = firebase.auth();
  const fs = firebase.firestore();
  try { fs.enablePersistence({ synchronizeTabs: true }).catch(() => {}); } catch (e) {}

  /* ---------- errors: map Firebase codes to the codes the app understands ---------- */
  const MAP = { 'permission-denied': 'invalid_argument', 'not-found': 'invalid_argument', 'invalid-argument': 'invalid_argument',
    'unauthenticated': 'invalid_argument', 'resource-exhausted': 'quota_exceeded', 'unavailable': 'unavailable', 'deadline-exceeded': 'unavailable' };
  const mapErr = (e) => ({ code: MAP[String((e && e.code) || '').replace(/^firestore\//, '')] || 'unavailable', message: String((e && e.message) || e) });
  const wrap = (p) => p.catch((e) => { throw mapErr(e); });

  /* ---------- db: Firestore with the same shape the app expects ---------- */
  const meta = (s) => ({ fromCache: !!s.metadata.fromCache, hasPendingWrites: !!s.metadata.hasPendingWrites });
  const snapD = (s) => ({ id: s.id, exists: !!s.exists, data: () => (s.exists ? s.data() : undefined), metadata: meta(s) });
  const snapQ = (s) => ({ docs: s.docs.map(snapD), size: s.size, empty: s.empty, metadata: meta(s), docChanges: () => s.docChanges() });
  const listen = (ref, conv, next, err) => ref.onSnapshot({ includeMetadataChanges: true }, (s) => next(conv(s)), (e) => err && err(mapErr(e)));
  function docRef(r) {
    return { id: r.id, path: r.path,
      get: () => wrap(r.get()).then(snapD), set: (d) => wrap(r.set(d)), update: (d) => wrap(r.update(d)),
      delete: () => wrap(r.delete()), onSnapshot: (n, e) => listen(r, snapD, n, e), collection: (p) => colRef(r.collection(p)) };
  }
  function query(q) {
    return { where: (a, b, c) => query(q.where(a, b, c)), orderBy: (a, b) => query(q.orderBy(a, b)), limit: (n) => query(q.limit(n)),
      get: () => wrap(q.get()).then(snapQ), onSnapshot: (n, e) => listen(q, snapQ, n, e) };
  }
  function colRef(c) {
    return Object.assign(query(c), { path: c.path, doc: (id) => docRef(id ? c.doc(id) : c.doc()), add: (d) => wrap(c.add(d)).then(docRef) });
  }
  const db = { doc: (p) => docRef(fs.doc(p)), collection: (p) => colRef(fs.collection(p)) };

  /* ---------- user ---------- */
  let resolveUser; const userReady = new Promise((r) => (resolveUser = r));
  // Roles come only from the security rules: a manager is whoever may open config/access,
  // a team member whoever may open the team list. No e-mail address is kept in the code.
  let roleCache = null;
  async function roles() {
    if (roleCache) return roleCache;
    const can = (p) => fs.doc(p).get().then(() => true, () => false);
    const admin = await can('config/access');
    const member = admin || await can('lists/main');
    return (roleCache = { admin, member });
  }
  const initials = (u) => {
    const t = String(u.displayName || u.email || '?').trim().charAt(0).toUpperCase().replace(/[<>&"']/g, '?');
    return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="20" fill="#FFC93C"/><text x="20" y="26" font-family="Arial" font-size="18" font-weight="700" text-anchor="middle" fill="#17171C">${t}</text></svg>`);
  };

  const user = {
    me: async () => { const u = await userReady; const r = await roles(); return { id: u.uid, name: u.displayName || '', email: u.email || null,
      avatarUrl: (u.photoURL && /^https:\/\//.test(u.photoURL)) ? u.photoURL : initials(u), color: '#E4002B', isOwner: r.admin, canEdit: r.admin }; },
    id: async () => (await userReady).uid,
    isOwner: async () => { await userReady; return (await roles()).admin; },
    canEdit: async () => { await userReady; return (await roles()).admin; },
    can: async (name) => { await userReady; return name === 'data.write' ? (await roles()).member : false; }
  };

  window.claude = { use: async (n) => { await userReady; return ({ db, user, downloads })[n] || null; } };
  window.APP_SIGN_OUT = () => { try { window.google && google.accounts && google.accounts.id.disableAutoSelect(); } catch (e) {} return auth.signOut().then(() => location.reload()); };

  /* ---------- sign-in screen ---------- */
  const AUTH_ERR = {
    'auth/invalid-credential': 'המייל או הסיסמה לא נכונים', 'auth/wrong-password': 'המייל או הסיסמה לא נכונים',
    'auth/user-not-found': 'לא נמצא חשבון עם המייל הזה', 'auth/email-already-in-use': 'כבר קיים חשבון עם המייל הזה. נסה להתחבר',
    'auth/weak-password': 'הסיסמה חלשה מדי, לפחות 6 תווים', 'auth/invalid-email': 'כתובת מייל לא תקינה',
    'auth/too-many-requests': 'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות', 'auth/network-request-failed': 'אין חיבור לאינטרנט',
    'auth/popup-closed-by-user': 'החלון נסגר לפני שההתחברות הסתיימה', 'auth/cancelled-popup-request': 'החלון נסגר לפני שההתחברות הסתיימה',
    'auth/unauthorized-domain': 'הכתובת של האתר לא מאושרת ב-Firebase. הוסף אותה ב-Authentication ← Settings ← Authorized domains',
    'auth/operation-not-allowed': 'שיטת ההתחברות הזו לא הופעלה ב-Firebase (Authentication ← Sign-in method)'
  };
  const msgOf = (e) => AUTH_ERR[e && e.code] || 'ההתחברות לא הצליחה, נסה שוב';
  let gate = null;
  function showGate() {
    if (gate) { gate.hidden = false; return; }
    gate = document.createElement('div');
    gate.id = 'gate';
    gate.setAttribute('role', 'dialog'); gate.setAttribute('aria-modal', 'true'); gate.setAttribute('aria-labelledby', 'gTitle');
    gate.innerHTML = `
      <div class="gcard">
        <div class="gtop"><svg viewBox="0 0 48 48" aria-hidden="true"><rect x="7" y="16" width="34" height="25" rx="4" fill="#fff"/><path d="M7 20h34" stroke="#E4002B" stroke-width="3"/><rect x="4" y="9" width="40" height="10" rx="3" fill="#FFC93C"/><path d="M19 29l4 4 7-8" fill="none" stroke="#E4002B" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <h1 id="gTitle">רשימת גריטה</h1><p>התחבר כדי לפתוח את הרשימה שלך</p></div>
        <div class="gbody">
          <div id="gsiBtn" class="gsi" hidden></div>
          <button type="button" class="gbtn google" id="gGoogle"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h6a5.2 5.2 0 0 1-2.2 3.4v2.8h3.6c2.1-1.9 3.2-4.8 3.2-8.2z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14c-.2-.7-.4-1.3-.4-2s.1-1.4.4-2V7.1H2a11 11 0 0 0 0 9.8L5.7 14z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2 7.1L5.7 10c.9-2.7 3.4-4.6 6.3-4.6z"/></svg>התחברות עם גוגל</button>
          <div class="gor"><span>או עם מייל וסיסמה</span></div>
          <form id="gForm" novalidate>
            <label>מייל<input id="gEmail" type="email" autocomplete="email" dir="ltr" required maxlength="254"></label>
            <label>סיסמה<input id="gPass" type="password" autocomplete="current-password" dir="ltr" required minlength="6" maxlength="128"></label>
            <p class="gerr" id="gErr" role="alert"></p>
            <button type="submit" class="gbtn main" id="gSubmit">התחברות</button>
          </form>
          <div class="glinks"><button type="button" id="gMode">אין לך חשבון? הרשמה</button><button type="button" id="gReset">שכחתי סיסמה</button></div>
        </div>
      </div>`;
    document.body.appendChild(gate);
    const $ = (s) => gate.querySelector(s);
    let signup = false;
    const err = (t, ok) => { const e = $('#gErr'); e.textContent = t || ''; e.classList.toggle('ok', !!ok); };
    const busy = (b) => gate.querySelectorAll('button,input').forEach((x) => (x.disabled = b));
    $('#gMode').onclick = () => { signup = !signup; $('#gSubmit').textContent = signup ? 'יצירת חשבון' : 'התחברות';
      $('#gMode').textContent = signup ? 'יש לך חשבון? התחברות' : 'אין לך חשבון? הרשמה';
      $('#gPass').autocomplete = signup ? 'new-password' : 'current-password'; err(''); };
    // Fallback only (used if Google's official button can't load): the classic Firebase popup.
    $('#gGoogle').onclick = async () => {
      err(''); busy(true);
      const p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' });
      const t = setTimeout(() => { busy(false); err('ההתחברות עם גוגל לא הסתיימה. נסה שוב, או התחבר עם מייל וסיסמה'); }, 90000);
      try { await auth.signInWithPopup(p); }
      catch (e) { err(e && e.code === 'auth/popup-blocked' ? 'הדפדפן חסם את חלון ההתחברות. אפשר חלונות קופצים לאתר הזה ונסה שוב' : msgOf(e)); }
      clearTimeout(t); busy(false);
    };
    // Primary: Google Identity Services. The ID token comes straight back to this page,
    // so it works on phones and in the installed app, where the popup flow can hang.
    if (gClientId) {
      const onCred = async (resp) => {
        err(''); busy(true);
        try { await auth.signInWithCredential(firebase.auth.GoogleAuthProvider.credential(resp.credential)); }
        catch (e) { err(msgOf(e)); }
        busy(false);
      };
      const start = () => {
        try {
          google.accounts.id.initialize({ client_id: gClientId, callback: onCred, auto_select: false, cancel_on_tap_outside: true,
            itp_support: true, use_fedcm_for_prompt: true, use_fedcm_for_button: true, context: 'signin' });
          const box = $('#gsiBtn');
          box.hidden = false; $('#gGoogle').hidden = true;
          google.accounts.id.renderButton(box, { type: 'standard', theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with',
            logo_alignment: 'center', locale: 'he', width: Math.min(380, Math.max(240, box.clientWidth || 320)) });
          google.accounts.id.prompt();
        } catch (e) { $('#gsiBtn').hidden = true; $('#gGoogle').hidden = false; }
      };
      if (window.google && google.accounts && google.accounts.id) start();
      else {
        const sc = document.createElement('script');
        sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.onload = start;
        sc.onerror = () => { $('#gsiBtn').hidden = true; $('#gGoogle').hidden = false; };
        document.head.appendChild(sc);
      }
    }
    $('#gForm').onsubmit = async (ev) => {
      ev.preventDefault(); err('');
      const email = $('#gEmail').value.trim(), pass = $('#gPass').value;
      if (!email || !pass) { err('מלא מייל וסיסמה'); return; }
      busy(true);
      try {
        if (signup) {
          const c = await auth.createUserWithEmailAndPassword(email, pass);
          try { await c.user.sendEmailVerification(); } catch (e) {}
        } else await auth.signInWithEmailAndPassword(email, pass);
      } catch (e) { err(msgOf(e)); }
      busy(false);
    };
    $('#gReset').onclick = async () => {
      const email = $('#gEmail').value.trim();
      if (!email) { err('כתוב את המייל שלך בשדה המייל ואז לחץ שוב'); $('#gEmail').focus(); return; }
      busy(true);
      try { await auth.sendPasswordResetEmail(email); err('אם קיים חשבון עם המייל הזה, נשלח אליו קישור לאיפוס סיסמה', true); }
      catch (e) { err(msgOf(e)); }
      busy(false);
    };
  }
  function hideGate() { if (gate) gate.hidden = true; }

  const style = document.createElement('style');
  style.textContent = `
  .setupbar{background:#FFC93C;color:#17171C;padding:10px 16px;font:600 14px/1.4 Rubik,Heebo,system-ui,sans-serif;text-align:center}
  #gate{position:fixed;inset:0;z-index:100;background:#E4002B;display:grid;place-items:center;padding:16px;overflow:auto;font-family:Rubik,Heebo,system-ui,sans-serif}
  #gate[hidden]{display:none}
  #gate .gcard{width:min(420px,100%);background:#fff;color:#17171C;border-radius:24px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25)}
  #gate .gtop{background:#FFF3CC;text-align:center;padding:22px 20px 16px}
  #gate .gtop svg{width:64px;height:64px;background:#E4002B;border-radius:18px;padding:8px}
  #gate h1{margin:10px 0 4px;font-size:30px;font-weight:800}
  #gate .gtop p{margin:0;color:#62626B}
  #gate .gbody{padding:20px;display:grid;gap:12px}
  #gate .gbtn{min-height:54px;border-radius:14px;font:700 17px Rubik,Heebo,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;width:100%}
  #gate .gbtn svg{width:22px;height:22px}
  #gate .google{background:#fff;border:2px solid #E3E3E8;color:#17171C}
  #gate .google[hidden]{display:none}
  #gate .gsi{display:flex;justify-content:center;min-height:44px}
  #gate .gsi[hidden]{display:none}
  #gate .main{background:#E4002B;border:0;color:#fff}
  #gate .gor{display:flex;align-items:center;gap:10px;color:#62626B;font-size:14px}
  #gate .gor::before,#gate .gor::after{content:"";flex:1;height:1px;background:#E3E3E8}
  #gate form{display:grid;gap:10px}
  #gate label{display:grid;gap:4px;font-weight:700;font-size:15px}
  #gate input{min-height:52px;border:2px solid #E3E3E8;border-radius:14px;padding:8px 14px;font:500 17px Rubik,Heebo,system-ui,sans-serif;background:#F6F6F8;color:#17171C}
  #gate input:focus{outline:none;border-color:#17171C;background:#fff}
  #gate .gerr{margin:0;color:#C20024;font-weight:700;font-size:14px}
  #gate .gerr.ok{color:#0E8A4A}
  #gate .gerr:empty{display:none}
  #gate .glinks{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
  #gate .glinks button{border:0;background:none;color:#17171C;text-decoration:underline;font:600 15px Rubik,Heebo,system-ui,sans-serif;min-height:44px;cursor:pointer}
  #gate button:disabled{opacity:.6}`;
  document.head.appendChild(style);

  auth.getRedirectResult().catch((e) => { showGate(); const el = document.getElementById('gErr'); if (el) el.textContent = msgOf(e); });
  auth.onAuthStateChanged((u) => {
    if (u) { hideGate(); resolveUser(u); }
    else if (document.body) showGate(); else document.addEventListener('DOMContentLoaded', showGate);
  });
})();
