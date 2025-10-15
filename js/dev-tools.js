
// Lightweight global dev helper
(function () {
  try {
    const qs = new URLSearchParams(location.search);
    const hasParam = qs.get("dev") === "1";
    const isLocal = /(^localhost$)|(^127\.0\.0\.1$)/.test(location.hostname);
    const stored = (localStorage.getItem("ct_dev") || "0") === "1";
    let enabled = hasParam || stored || isLocal;

    function setEnabled(on) {
      enabled = !!on;
      localStorage.setItem("ct_dev", on ? "1" : "0");
      badge && (badge.style.display = on ? "block" : "none");
      toast(on ? "DEV enabled" : "DEV disabled");
    }

    // toggler: Ctrl/⌘ + D
    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setEnabled(!enabled);
      }
    });

    // Badge
    const badge = document.createElement("div");
    badge.textContent = "DEV MODE";
    badge.style.cssText = "position:fixed;top:8px;right:8px;z-index:99999;padding:6px 10px;background:#111;color:#fff;border-radius:8px;font:600 12px/1 system-ui;opacity:0.9;";
    badge.style.display = enabled ? "block" : "none";
    document.addEventListener("DOMContentLoaded", () => document.body.appendChild(badge));

    function toast(msg) {
      const el = document.createElement("div");
      el.textContent = msg;
      el.style.cssText = "position:fixed;bottom:12px;right:12px;z-index:99999;padding:10px 14px;background:#111;color:#fff;border-radius:10px;font:600 13px/1.2 system-ui;opacity:0.95;transition:opacity .3s";
      document.body.appendChild(el);
      setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 1100);
    }

    function pageNext() {
      // 1) window.CT_NEXT (string or function) has priority
      if (typeof window.CT_NEXT === "function") {
        try {
          const res = window.CT_NEXT();
          if (res) return res;
        } catch (e) {}
      } else if (typeof window.CT_NEXT === "string" && window.CT_NEXT.trim()) {
        return window.CT_NEXT.trim();
      }
      // 2) meta tag hint
      const meta = document.querySelector('meta[name="ct-next"]');
      if (meta && meta.content) return meta.content;
      // 3) common fallback: enabled next button
      const btn = document.getElementById("nextBtn") || document.querySelector("[data-next]");
      if (btn && btn.getAttribute) {
        const href = btn.getAttribute("data-next") || btn.getAttribute("href");
        if (href) return href;
      }
      return null;
    }

    function enableNextButton() {
      const btn = document.getElementById("nextBtn") || document.querySelector("button.primary, .btn.primary, button");
      if (btn) {
        btn.disabled = false;
        btn.classList.remove("opacity-50","pointer-events-none");
        try { btn.textContent = (btn.textContent || "Next").replace(/\s*\(dev\)$/,"") + " (dev)"; } catch (e) {}
      } else {
        toast("No next button found");
      }
    }

    function autoAdvance() {
      enableNextButton();
      setTimeout(() => {
        const btn = document.getElementById("nextBtn") || document.querySelector("button.primary, .btn.primary, button");
        if (btn) btn.click();
      }, 800);
    }

    function toggleMute() {
      const v = document.querySelector("video");
      if (v) {
        v.muted = !v.muted;
        try { v.play().catch(()=>{}); } catch(e){}
        toast(v.muted ? "Muted" : "Unmuted");
      } else {
        toast("No video");
      }
    }

    // Keyboard shortcuts (dev only)
    window.addEventListener("keydown", (e) => {
      if (!enabled) return;
      const tag = (e.target && (e.target.tagName || "")).toLowerCase();
      if (tag === "input" || tag === "textarea" || e.isComposing) return;

      // q → skip to next
      if (e.key.toLowerCase() === "q") {
        const url = pageNext();
        if (url) location.href = url + (url.includes("?") ? "&" : "?") + "dev=1";
        else toast("No next route found");
      }
      // n → enable Next
      if (e.key.toLowerCase() === "n") {
        enableNextButton();
      }
      // a → auto-advance
      if (e.key.toLowerCase() === "a") {
        autoAdvance();
      }
      // m → mute/unmute video
      if (e.key.toLowerCase() === "m") {
        toggleMute();
      }
      // ? → help
      if (e.key === "?") {
        toast("Dev keys: q=skip, n=enable Next, a=auto-advance, m=toggle mute, Ctrl/⌘+D=toggle dev");
      }
    });
  } catch (e) {
    // fail silently
  }
})();
