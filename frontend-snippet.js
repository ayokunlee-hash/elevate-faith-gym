/* =====================================================================
   Elevate Faith Gym: real auth wiring (production build)
   ---------------------------------------------------------------------
   Paste this just before </body> in index.html.

   What it does:
   - "Sign up with Google" goes to /api/auth/google-start (real OAuth).
   - "Sign up with email" asks for the email, then POSTs to
     /api/auth/email-start, which sends a 15-minute magic link via Resend.
   - After either login, the page fetches /api/auth/me. If the family has
     not finished setup, the parent name from the Google account is
     pre-filled into the (editable) parent name field, the setup view is
     shown, and the rest of the app stays blocked until setup completes.

   Lines marked ADAPT point at the real element ids and view functions in
   index.html. Adjust them to match.
   ===================================================================== */
(function () {
  'use strict';

  // ADAPT: if the buttons have ids in index.html, use them here.
  function findButton(label) {
    var match = Array.prototype.find.call(
      document.querySelectorAll('button'),
      function (b) {
        return (b.textContent || '').trim().toLowerCase() === label.toLowerCase();
      }
    );
    return match || null;
  }

  async function getMe() {
    try {
      var res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) return { signedIn: false };
      return await res.json();
    } catch (e) {
      return { signedIn: false };
    }
  }

  function showSetup() {
    // ADAPT: call the app's own function that displays the setup view.
    if (typeof window.showSetupView === 'function') {
      window.showSetupView();
      return;
    }
    location.hash = '#setup';
  }

  function prefillParentName(name) {
    // ADAPT: point this at the real parent name input.
    var input =
      document.getElementById('parent-name') ||
      document.querySelector('input[name="parentName"]');
    if (input && name) {
      input.value = name; // pre-filled from Google, still editable
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // After any login return: route unfinished families to setup and block
  // the rest of the app until setup completes.
  async function afterAuthReturn() {
    var me = await getMe();
    if (!me.signedIn) return; // guest flow continues as before
    if (!me.family.setupCompleted) {
      prefillParentName(me.family.parentName);
      showSetup();
      document.body.classList.add('efg-require-setup');
      // ADAPT: also gate your router here, e.g. hide the bottom nav
      // while document.body has the efg-require-setup class.
    }
  }

  // Sends the parent-created 4-digit PIN to the server, which stores only
  // a salted hash. Call this when the parent sets the PIN on the form.
  async function saveParentPin(pin) {
    var res = await fetch('/api/auth/set-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: pin }),
    });
    return res.ok;
  }

  // Call this when the parent taps the final setup button. It saves any
  // edited parent name, marks setup complete server-side, and unblocks
  // the app.
  async function finishSetup() {
    // ADAPT: point this at the real parent name input.
    var nameInput = document.getElementById('parent-name');
    var res = await fetch('/api/auth/setup-complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentName: nameInput ? nameInput.value : '' }),
    });
    if (res.ok) {
      document.body.classList.remove('efg-require-setup');
      if (typeof window.enterApp === 'function') window.enterApp();
    } else {
      alert('Could not finish setup. Please check your connection and try again.');
    }
    return res.ok;
  }

  async function signOut() {
    window.location.href = '/api/auth/logout';
  }

  function wireButtons() {
    var googleBtn = findButton('Sign up with Google');
    if (googleBtn) {
      googleBtn.disabled = false; // the prototype disabled this; enable it now
      googleBtn.addEventListener('click', function () {
        window.location.href = '/api/auth/google-start';
      });
    }

    var emailBtn = findButton('Sign up with email');
    if (emailBtn) {
      emailBtn.disabled = false;
      emailBtn.addEventListener('click', async function () {
        var email = window.prompt('Enter your email to sign up:');
        if (!email) return;
        emailBtn.disabled = true;
        try {
          await fetch('/api/auth/email-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email }),
          });
          alert('Check your email for the sign-in link. It expires in 15 minutes.');
        } catch (e) {
          alert('Something went wrong. Please try again.');
        } finally {
          emailBtn.disabled = false;
        }
      });
    }
  }

  // Public helpers the app can call.
  window.EFG_AUTH = {
    getMe: getMe,
    saveParentPin: saveParentPin,
    finishSetup: finishSetup,
    signOut: signOut,
    afterAuthReturn: afterAuthReturn,
  };

  document.addEventListener('DOMContentLoaded', function () {
    wireButtons();
    afterAuthReturn();
  });
})();
