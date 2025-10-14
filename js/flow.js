// js/flow.js
// Firebase CDN v10.x
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import {
  getAuth, signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, runTransaction,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

/* =========================
   Paths (relative to id_check.html)
   ========================= */
const PATHS = {
  consent: "consent.html",
  instructions: "instructions.html",
  task: (n) => `session${n}/index.html`,
  debrief: "debrief.html",
};

/* =========================
   Collection names (match your DB)
   ========================= */
const COLLECTIONS = {
  preIds: "pre_ids",         // <-- underscore version in your Firestore
  participants: "participants",
};

/* =========================
   App init (expects window.FB_CONFIG to exist)
   ========================= */
export function initApp() {
  if (!window.FB_CONFIG) {
    throw new Error("FB_CONFIG is missing. Make sure js/firebase-config.js sets window.FB_CONFIG.");
  }
  const app = initializeApp(window.FB_CONFIG);
  const auth = getAuth(app);
  // Best-effort anon sign-in so Rules work; ignore failures
  signInAnonymously(auth).catch(() => {});
  const db = getFirestore(app);
  return { app, db, auth };
}

/* =========================
   Utilities
   ========================= */
function addHours(ts, hrs) {
  const ms = ts.toMillis() + hrs * 3600 * 1000;
  return Timestamp.fromMillis(ms);
}

// If pre_ids has a group preset, use it; otherwise default.
// Replace with your real balancer later if needed.
async function assignBalancedGroup({ presetGroup } = {}) {
  if (presetGroup) return presetGroup;
  return "child-EN";
}

/* =========================
   Core: verify existing ID (no auto-generate)
   ========================= */
export async function handleIdSubmit({ db, inputId = "" }) {
  // Strict: an ID is required
  if (!inputId) return { blocked: { type: "invalid" } };

  // 1) Look up in pre_ids
  const preRef = doc(db, COLLECTIONS.preIds, inputId);
  const preSnap = await getDoc(preRef);

  if (preSnap.exists()) {
    const resultId = await runTransaction(db, async (tx) => {
      const pre = await tx.get(preRef);
      if (!pre.exists()) throw new Error("pre_id disappeared during transaction.");
      const pRef = doc(db, COLLECTIONS.participants, inputId);
      const pSnap = await tx.get(pRef);

      // Normalize legacy statuses: allow "unused" -> "available"
      const raw = pre.get("status");
      const status = raw === "unused" ? "available" : (raw || "available");
      const presetGroup = pre.get("group");

      if (status === "available") {
        // First-time claim
        const group = await assignBalancedGroup({ presetGroup });
        tx.set(preRef, { status: "used", claimedAt: serverTimestamp(), claimedBy: inputId }, { merge: true });

        if (!pSnap.exists()) {
          tx.set(pRef, {
            participantId: inputId,
            group,
            nextSession: 1,
            createdAt: serverTimestamp(),
            sessions: {
              1: { startedAt: null, completedAt: null, withdrawnAt: null, windowOpenAt: null, windowCloseAt: null, lang: null },
              2: { startedAt: null, completedAt: null, withdrawnAt: null, windowOpenAt: null, windowCloseAt: null, lang: null },
              3: { startedAt: null, completedAt: null, withdrawnAt: null, windowOpenAt: null, windowCloseAt: null, lang: null },
            },
          }, { merge: true });
        }
      } else if (status === "used") {
        // Legacy path: ensure participants doc exists so routing can proceed
        if (!pSnap.exists()) {
          const group = await assignBalancedGroup({ presetGroup });
          tx.set(pRef, {
            participantId: inputId,
            group,
            nextSession: 1,
            createdAt: serverTimestamp(),
            sessions: {
              1: { startedAt: null, completedAt: null, withdrawnAt: null, windowOpenAt: null, windowCloseAt: null, lang: null },
              2: { startedAt: null, completedAt: null, withdrawnAt: null, windowOpenAt: null, windowCloseAt: null, lang: null },
              3: { startedAt: null, completedAt: null, withdrawnAt: null, windowOpenAt: null, windowCloseAt: null, lang: null },
            },
          }, { merge: true });
        }
      } else {
        throw new Error("Invalid pre_id status");
      }

      return inputId;
    });

    localStorage.setItem("ct.participantId", resultId);
    return routeFromParticipant({ db, participantId: resultId });
  }

  // 2) Fallback: participant doc already exists without pre_ids
  const pRef = doc(db, COLLECTIONS.participants, inputId);
  const pSnap = await getDoc(pRef);
  if (pSnap.exists()) {
    localStorage.setItem("ct.participantId", inputId);
    return routeFromParticipant({ db, participantId: inputId });
  }

  // 3) Not found at all
  return { blocked: { type: "invalid" } };
}

/* =========================
   Routing from participant state
   ========================= */
async function routeFromParticipant({ db, participantId }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);
  const snap = await getDoc(pRef);
  if (!snap.exists()) return { blocked: { type: "invalid" } };

  const data = snap.data();
  const next = data.nextSession;

  // Completed all sessions
  if (next === "done") {
    return { blocked: { type: "completedAll" } };
  }

  const sess = data.sessions?.[next];
  if (!sess) return { blocked: { type: "invalid" } };

  // No-resume policy: started but not completed => invalid
  if (sess.startedAt && !sess.completedAt) {
    return { blocked: { type: "invalid" } };
  }

  // Session 1 => go to consent
  if (next === 1) {
    window.location.href = PATHS.consent;
    return { ok: true };
  }

  // Session 2/3 => enforce 48–72h window
  const openAt = sess.windowOpenAt?.toDate?.() || null;
  const closeAt = sess.windowCloseAt?.toDate?.() || null;
  const now = new Date();

  if (!openAt || !closeAt) return { blocked: { type: "invalid" } };
  if (now < openAt) return { blocked: { type: "tooEarly", session: next, openAt, closeAt } };
  if (now > closeAt) return { blocked: { type: "invalid" } };

  // Eligible now
  window.location.href = PATHS.instructions;
  return { ok: true };
}

/* =========================
   Helpers for the ID page to render messages
   ========================= */
export function showBlockedMessage(block) {
  const el = document.getElementById("msg");
  if (!el) return;

  const fmt = (d) =>
    d?.toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "2-digit",
    });

  switch (block.type) {
    case "completedAll":
      el.textContent = "This participant has completed all sessions. Thank you!";
      break;
    case "tooEarly":
      el.textContent = `Too early. Session ${block.session} opens ${fmt(block.openAt)} and closes ${fmt(block.closeAt)}.`;
      break;
    case "invalid":
      el.textContent = "Invalid ID or not eligible to continue.";
      break;
    default:
      el.textContent = "Sorry, you can’t continue right now.";
  }
}

/* =========================
   Session lifecycle (call from other pages)
   ========================= */
export async function beginSession({ db, participantId, sessionNumber }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);

  // 1) Mark start (Rules should enforce the S2/S3 window if you add them)
  await updateDoc(pRef, {
    [`sessions.${sessionNumber}.startedAt`]: serverTimestamp(),
    nextSession: sessionNumber,
  });

  // 2) Read back to get the resolved server timestamp
  const snap = await getDoc(pRef);
  const data = snap.data();
  const startedAt = data?.sessions?.[sessionNumber]?.startedAt;
  if (!startedAt) throw new Error("Failed to stamp startedAt");

  // 3) Precompute next window
  const next = sessionNumber + 1;
  if (next <= 3) {
    const openAt = addHours(startedAt, 48);
    const closeAt = addHours(startedAt, 72);
    await updateDoc(pRef, {
      [`sessions.${next}.windowOpenAt`]: openAt,
      [`sessions.${next}.windowCloseAt`]: closeAt,
      nextSession: next,
    });
  } else {
    await updateDoc(pRef, { nextSession: "done" });
  }
}

export async function completeSession({ db, participantId, sessionNumber }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);
  const patch = { [`sessions.${sessionNumber}.completedAt`]: serverTimestamp() };
  if (sessionNumber === 3) patch["nextSession"] = "done";
  await updateDoc(pRef, patch);
}
