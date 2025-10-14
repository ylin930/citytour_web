// js/flow.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  runTransaction,
  serverTimestamp,
  Timestamp,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";

/* -------- Paths -------- */
const PATHS = {
  consent: "consent.html",
  instructions: "instructions.html",
  task: (n) => `session${n}/index.html`,
  debrief: "debrief.html"
};

/* -------- Collections -------- */
const COLLECTIONS = {
  preIds: "pre_ids",
  participants: "participants",
  idMapping: "id_mapping"
};

/* -------- Init -------- */
export function initApp() {
  if (!window.FB_CONFIG)
    throw new Error("FB_CONFIG is missing. Make sure js/firebase-config.js sets window.FB_CONFIG.");
  const app = initializeApp(window.FB_CONFIG);
  const auth = getAuth(app);
  signInAnonymously(auth).catch(() => {});
  const db = getFirestore(app);
  return { app, db, auth };
}

/* -------- Utils -------- */
function addHours(ts, hrs) {
  const ms = ts.toMillis() + hrs * 3600 * 1000;
  return Timestamp.fromMillis(ms);
}
async function assignBalancedGroup({ presetGroup } = {}) {
  return presetGroup || "child-EN";
}
function randomId(len = 8) {
  // Base36 uppercase, length ~8
  let s = "";
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len).toUpperCase();
}

/* -------- Mapping helpers -------- */
async function findMappingByPreId(db, preId) {
  const q = query(collection(db, COLLECTIONS.idMapping), where("pre_id", "==", preId));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  // document id IS new_id in your data; prefer that
  const docSnap = snap.docs[0];
  return { newId: docSnap.id, data: docSnap.data() };
}

async function createMappingTxn(tx, db, preId, presetGroup) {
  // generate a new internal id (retry if collision)
  let newId;
  let tries = 0;
  while (tries < 5) {
    newId = randomId(8);
    const mRef = doc(db, COLLECTIONS.idMapping, newId);
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists()) {
      // create mapping
      const group = await assignBalancedGroup({ presetGroup });
      tx.set(mRef, {
        pre_id: preId,
        new_id: newId,
        group,
        assigned_at: serverTimestamp(),
        completed: false
        // age/gender will be filled later from demographics
      });
      return { newId, group };
    }
    tries++;
  }
  throw new Error("Could not generate unique new_id");
}

/* -------- Verify-only: claim/resume using pre_ids + id_mapping -------- */
export async function handleIdSubmit({ db, inputId = "" }) {
  if (!inputId) return { blocked: { type: "invalid" } };
  const preId = inputId;

  // 1) Look up the pre_id doc
  const preRef = doc(db, COLLECTIONS.preIds, preId);
  const preSnap = await getDoc(preRef);

  if (preSnap.exists()) {
    // Transaction to flip pre_ids status and (if needed) create mapping + participant
    const { pid } = await runTransaction(db, async (tx) => {
      const pre = await tx.get(preRef);
      if (!pre.exists()) throw new Error("pre_id disappeared");
      const raw = pre.get("status");
      const status = raw === "unused" ? "available" : raw || "available";
      const presetGroup = pre.get("group") || null;

      // Try to find existing mapping (outside txn we can't query,
      // but we can read if we know the id—here we don't).
      // We'll handle existing mapping AFTER txn for the "used" case.

      if (status === "available") {
        // createMappingTxn probably does some writes (id_mapping / balance_rules)
        // so DO NOT read after it inside the same transaction.
        const { newId, group } = await createMappingTxn(tx, db, preId, presetGroup);

        const pRef = doc(db, COLLECTIONS.participants, newId);

        // ❌ DO NOT: const pSnap = await tx.get(pRef);  // read-after-write violates txn rules
        // ✅ Just set/merge without reading first:
        tx.set(
          pRef,
          {
            participantId: newId,
            preId, // keep link to the pre code
            group,
            nextSession: 1,
            createdAt: serverTimestamp(),
            sessions: {
              1: {
                startedAt: null,
                completedAt: null,
                withdrawnAt: null,
                windowOpenAt: null,
                windowCloseAt: null,
                lang: null
              },
              2: {
                startedAt: null,
                completedAt: null,
                withdrawnAt: null,
                windowOpenAt: null,
                windowCloseAt: null,
                lang: null
              },
              3: {
                startedAt: null,
                completedAt: null,
                withdrawnAt: null,
                windowOpenAt: null,
                windowCloseAt: null,
                lang: null
              }
            }
          },
          { merge: true }
        );

        // flip pre_id to used
        tx.update(preRef, { status: "used", claimedAt: serverTimestamp(), claimedBy: newId });

        return { pid: newId };
      }

      if (status === "used") {
        // We'll resolve mapping after the txn; nothing to write in pre_ids
        return { pid: null };
      }

      throw new Error("Invalid pre_id status");
    });

    // If we already created/returned pid in txn, go on
    if (pid) {
      localStorage.setItem("ct.participantId", pid);
      localStorage.setItem("ct.preId", preId);
      return routeFromParticipant({ db, participantId: pid });
    }

    // pre_id was "used" — find mapping and ensure participant exists
    const found = await findMappingByPreId(db, preId);
    let mappedId = found?.newId || null;

    if (!mappedId) {
      // Edge case: "used" but no mapping found (legacy). Create one now.
      const newId = randomId(8);
      await setDoc(
        doc(db, COLLECTIONS.idMapping, newId),
        {
          pre_id: preId,
          new_id: newId,
          assigned_at: serverTimestamp(),
          completed: false
        },
        { merge: true }
      );
      mappedId = newId;
    }

    // Ensure participants/{mappedId} exists
    const pRef = doc(db, COLLECTIONS.participants, mappedId);
    const pSnap = await getDoc(pRef);
    if (!pSnap.exists()) {
      await setDoc(
        pRef,
        {
          participantId: mappedId,
          preId,
          group: found?.data?.group || "child-EN",
          nextSession: 1,
          createdAt: serverTimestamp(),
          sessions: {
            1: {
              startedAt: null,
              completedAt: null,
              withdrawnAt: null,
              windowOpenAt: null,
              windowCloseAt: null,
              lang: null
            },
            2: {
              startedAt: null,
              completedAt: null,
              withdrawnAt: null,
              windowOpenAt: null,
              windowCloseAt: null,
              lang: null
            },
            3: {
              startedAt: null,
              completedAt: null,
              withdrawnAt: null,
              windowOpenAt: null,
              windowCloseAt: null,
              lang: null
            }
          }
        },
        { merge: true }
      );
    }

    localStorage.setItem("ct.participantId", mappedId);
    localStorage.setItem("ct.preId", preId);
    return routeFromParticipant({ db, participantId: mappedId });
  }

  // 2) No pre_ids doc — maybe they pasted the internal ID (new_id)
  //    Allow direct resume with participants/{new_id}
  const pRef = doc(db, COLLECTIONS.participants, inputId);
  const pSnap = await getDoc(pRef);
  if (pSnap.exists()) {
    localStorage.setItem("ct.participantId", inputId);
    return routeFromParticipant({ db, participantId: inputId });
  }

  // 3) Not found
  return { blocked: { type: "invalid" } };
}

/* -------- routing & session helpers (unchanged) -------- */
async function routeFromParticipant({ db, participantId }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);
  const snap = await getDoc(pRef);
  if (!snap.exists()) return { blocked: { type: "invalid" } };

  const data = snap.data();
  const next = data.nextSession;
  if (next === "done") return { blocked: { type: "completedAll" } };

  const sess = data.sessions?.[next];
  if (!sess) return { blocked: { type: "invalid" } };

  if (sess.startedAt && !sess.completedAt) return { blocked: { type: "invalid" } };

  if (next === 1) {
    window.location.href = PATHS.consent;
    return { ok: true };
  }

  const openAt = sess.windowOpenAt?.toDate?.() || null;
  const closeAt = sess.windowCloseAt?.toDate?.() || null;
  const now = new Date();
  if (!openAt || !closeAt) return { blocked: { type: "invalid" } };
  if (now < openAt) return { blocked: { type: "tooEarly", session: next, openAt, closeAt } };
  if (now > closeAt) return { blocked: { type: "invalid" } };

  window.location.href = PATHS.instructions;
  return { ok: true };
}

export function showBlockedMessage(block) {
  const el = document.getElementById("msg");
  if (!el) return;
  const fmt = (d) =>
    d?.toLocaleString(undefined, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      month: "short",
      day: "2-digit"
    });
  switch (block.type) {
    case "completedAll":
      el.textContent = "This participant has completed all sessions. Thank you!";
      break;
    case "tooEarly":
      el.textContent = `Too early. Session ${block.session} opens ${fmt(block.openAt)} and closes ${fmt(block.closeAt)}.`;
      break;
    case "invalid":
    default:
      el.textContent = "Invalid ID or not eligible to continue.";
  }
}

/* ----- beginSession / completeSession (same as before) ----- */
export async function beginSession({ db, participantId, sessionNumber }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);
  await updateDoc(pRef, { [`sessions.${sessionNumber}.startedAt`]: serverTimestamp(), nextSession: sessionNumber });
  const snap = await getDoc(pRef);
  const startedAt = snap.data()?.sessions?.[sessionNumber]?.startedAt;
  if (!startedAt) throw new Error("Failed to stamp startedAt");
  const next = sessionNumber + 1;
  if (next <= 3) {
    await updateDoc(pRef, {
      [`sessions.${next}.windowOpenAt`]: addHours(startedAt, 48),
      [`sessions.${next}.windowCloseAt`]: addHours(startedAt, 72),
      nextSession: next
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
