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

/* -------- PATHS -------- */
const PATHS = {
  consent: "2_consent.html",
  instructions: "4_instructions.html",
  task: (n) => `session${n}/index.html`,
  debrief: "debrief.html"
};

/* -------- COLLECTIONS -------- */
const COLLECTIONS = {
  preIds: "pre_ids",
  participants: "participants",
  idMapping: "id_mapping",
  balanceRules: "balance_rules"
};

/* -------- CONSENT ROUTING -------- */
// Folder where your consent files live:
const CONSENT_DIR = "consents/";

// Filenames (exact, with underscores — no spaces)
const CONSENT_FILES = {
  EN: {
    adult: "consent_US_adult_EN.html",
    child: "consent_US_child_EN.html"
  },
  GER: {
    adult: "consent_DE_adult_GER.html",
    child: "consent_DE_child_GER.html"
  }
};

function getConsentPage() {
  const lang = (localStorage.getItem("ct.lang") || "").toUpperCase(); // "EN" / "GER"
  const group = (localStorage.getItem("ct.group") || "").toLowerCase(); // "adult" / "child"
  const file = CONSENT_FILES[lang]?.[group] || "2_consent.html";
  // Return full path in /consents/
  return CONSENT_DIR + file;
}

/* -------- INIT FIREBASE -------- */
export function initApp() {
  if (!window.FB_CONFIG)
    throw new Error("FB_CONFIG is missing. Make sure js/firebase-config.js sets window.FB_CONFIG.");
  const app = initializeApp(window.FB_CONFIG);
  const auth = getAuth(app);
  signInAnonymously(auth).catch(() => {});
  const db = getFirestore(app);
  return { app, db, auth };
}

/* -------- UTILS -------- */
function addHours(ts, hrs) {
  const ms = ts.toMillis() + hrs * 3600 * 1000;
  return Timestamp.fromMillis(ms);
}

async function assignBalancedGroup({ db, presetGroup } = {}) {
  // Always use UI selection if available
  const fromUI = (localStorage.getItem("ct.group") || "").toLowerCase();
  console.log("assignBalancedGroup - fromUI:", fromUI, "presetGroup:", presetGroup);
  console.log("assignBalancedGroup - localStorage values:", {
    "ct.group": localStorage.getItem("ct.group"),
    "ct_role": localStorage.getItem("ct_role"),
    "ct_language": localStorage.getItem("ct_language"),
    "ct.lang": localStorage.getItem("ct.lang")
  });
  
  if (fromUI === "adult" || fromUI === "child") {
    console.log("assignBalancedGroup - using UI selection:", fromUI);
    return fromUI;
  }
  
  // Fallback to preset group
  if (presetGroup) {
    console.log("assignBalancedGroup - using preset group:", presetGroup.toLowerCase());
    return presetGroup.toLowerCase();
  }
  
  // Default to adult if no selection
  console.log("assignBalancedGroup - using default: adult");
  return "adult";
}

async function getBalancedVersion(db, group) {
  try {
    // Get current counts for this group
    const ruleRef = doc(db, COLLECTIONS.balanceRules, group);
    const ruleSnap = await getDoc(ruleRef);
    
    let version1Count = 0;
    let version2Count = 0;
    let version3Count = 0;
    let version4Count = 0;
    
    if (ruleSnap.exists()) {
      const data = ruleSnap.data();
      version1Count = data.version1 || 0;
      version2Count = data.version2 || 0;
      version3Count = data.version3 || 0;
      version4Count = data.version4 || 0;
    }
    
    // Find the version with the fewest participants
    const counts = [
      { version: 1, count: version1Count },
      { version: 2, count: version2Count },
      { version: 3, count: version3Count },
      { version: 4, count: version4Count }
    ];
    
    // Sort by count and assign to the one with fewest participants
    counts.sort((a, b) => a.count - b.count);
    const assignedVersion = counts[0].version;
    
    // Update the count
    await updateDoc(ruleRef, {
      [`version${assignedVersion}`]: counts[0].count + 1,
      lastAssigned: serverTimestamp()
    });
    
    return assignedVersion;
  } catch (error) {
    console.error("Error in balancing:", error);
    // Default to version 1 if balancing fails
    return 1;
  }
}

function randomId(len = 8) {
  let s = "";
  while (s.length < len) s += Math.random().toString(36).slice(2);
  return s.slice(0, len).toUpperCase();
}

/* -------- ID-MAPPING HELPERS -------- */
async function findMappingByPreId(db, preId) {
  const q = query(collection(db, COLLECTIONS.idMapping), where("pre_id", "==", preId));
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const docSnap = snap.docs[0];
  return { newId: docSnap.id, data: docSnap.data() };
}

async function createMappingTxn(tx, db, preId, presetGroup) {
  // Generate unique internal ID (new_id)
  let newId;
  let tries = 0;
  while (tries < 5) {
    newId = randomId(8);
    const mRef = doc(db, COLLECTIONS.idMapping, newId);
    const mSnap = await tx.get(mRef);
    if (!mSnap.exists()) {
      console.log("createMappingTxn - creating new mapping for preId:", preId, "presetGroup:", presetGroup);
      const group = await assignBalancedGroup({ db, presetGroup });
      console.log("createMappingTxn - assigned group:", group);
      
      tx.set(mRef, {
        pre_id: preId,
        new_id: newId,
        group,
        assigned_at: serverTimestamp(),
        completed: false
      });
      return { newId, group };
    }
    tries++;
  }
  throw new Error("Could not generate unique new_id");
}

/* -------- VERIFY / CLAIM ID -------- */
export async function handleIdSubmit({ db, inputId = "" }) {
  if (!inputId) return { blocked: { type: "invalid" } };
  const preId = inputId;

  // Step 1: Look up pre_ids
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
      console.log("handleIdSubmit - presetGroup from database:", presetGroup);
      console.log("handleIdSubmit - pre_ids document data:", pre.data());

      if (status === "available") {
        // Create mapping + participant under PRE ID (not newId)
        const { newId, group } = await createMappingTxn(tx, db, preId, presetGroup);
        console.log("handleIdSubmit - group assigned:", group);
        const pRef = doc(db, COLLECTIONS.participants, preId);

        // Get language and country from localStorage
        const lang = (localStorage.getItem("ct.lang") || localStorage.getItem("ct_language") || "EN").toUpperCase();
        const country = (localStorage.getItem("ct_country") || (lang === "GER" ? "DE" : "US")).toUpperCase();
        console.log("handleIdSubmit - storing participant with group:", group, "lang:", lang, "country:", country);
        console.log("handleIdSubmit - about to store in participants collection:", {
          participantId: preId,
          newId,
          preId,
          group,
          language: lang,
          country: country
        });

        tx.set(
          pRef,
          {
            participantId: preId,
            newId,
            preId,
            group,
            language: lang,
            country: country,
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

        tx.update(preRef, { status: "used", claimedAt: serverTimestamp(), claimedBy: preId });
        return { pid: preId };
      }

      if (status === "used") return { pid: null };
      throw new Error("Invalid pre_id status");
    });

    // If created new participant → assign version and proceed
    if (pid) {
      // Get the group from the participant data to assign version
      const pRef = doc(db, COLLECTIONS.participants, pid);
      const pSnap = await getDoc(pRef);
      if (pSnap.exists()) {
        const group = pSnap.data().group;
        const version = await getBalancedVersion(db, group);
        await updateDoc(pRef, { version });
      }
      
      localStorage.setItem("ct.participantId", pid);
      localStorage.setItem("ct.preId", preId);
      return { ok: true }; // Don't redirect, let the calling page handle it
    }

    // If already "used", look up mapping and ensure participant exists
    const found = await findMappingByPreId(db, preId);
    let mappedId = found?.newId || null;

    if (!mappedId) {
      // Edge case: create one now
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

    // Ensure participants/{preId} exists
    const pRef = doc(db, COLLECTIONS.participants, preId);
    const pSnap = await getDoc(pRef);
    if (!pSnap.exists()) {
      // Get language and country from localStorage
      const lang = (localStorage.getItem("ct.lang") || localStorage.getItem("ct_language") || "EN").toUpperCase();
      const country = (localStorage.getItem("ct_country") || (lang === "GER" ? "DE" : "US")).toUpperCase();
      
      await setDoc(
        pRef,
        {
          participantId: preId,
          newId: mappedId,
          preId,
          group: found?.data?.group || "child",
          language: lang,
          country: country,
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

    localStorage.setItem("ct.participantId", preId);
    localStorage.setItem("ct.preId", preId);
    return { ok: true }; // Don't redirect, let the calling page handle it
  }

  // Step 2: No pre_id found — try participants directly
  const pRef = doc(db, COLLECTIONS.participants, inputId);
  const pSnap = await getDoc(pRef);
  if (pSnap.exists()) {
    localStorage.setItem("ct.participantId", inputId);
    return { ok: true }; // Don't redirect, let the calling page handle it
  }

  return { blocked: { type: "invalid" } };
}

/* -------- ROUTING LOGIC -------- */
async function routeFromParticipant({ db, participantId }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);
  const snap = await getDoc(pRef);
  if (!snap.exists()) return { blocked: { type: "invalid" } };

  const data = snap.data();
  const next = data.nextSession;

  // ✅ Store current session number locally
  localStorage.setItem("ct_session", String(next));

  if (next === "done") return { blocked: { type: "completedAll" } };

  const sess = data.sessions?.[next];
  if (!sess) return { blocked: { type: "invalid" } };
  if (sess.startedAt && !sess.completedAt) return { blocked: { type: "invalid" } };

  // --- Session 1: go to appropriate consent page ---
  if (next === 1) {
    window.location.href = "2_consent.html";
    return { ok: true };
  }

  // --- Session 2 and 3 ---
  const openAt = sess.windowOpenAt?.toDate?.() || null;
  const closeAt = sess.windowCloseAt?.toDate?.() || null;
  const now = new Date();

  if (!openAt || !closeAt) return { blocked: { type: "invalid" } };
  if (now < openAt)
    return { blocked: { type: "tooEarly", session: next, openAt, closeAt } };
  if (now > closeAt)
    return { blocked: { type: "invalid" } };

  window.location.href = "4_instructions.html";
  return { ok: true };
}


/* -------- STATUS MESSAGES -------- */
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

/* -------- SESSION HELPERS -------- */
// Do NOT advance nextSession here.
// We stamp startedAt for the current session,
// and (optionally) pre-compute S2/S3 windows,
// but we keep nextSession = current until completion.
export async function beginSession({ db, participantId, sessionNumber }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);

  // 1) mark session started
  await updateDoc(pRef, {
    [`sessions.${sessionNumber}.startedAt`]: serverTimestamp(),
    // keep nextSession at current (or leave unchanged)
    nextSession: sessionNumber
  });

  // 2) read back server time so we can compute windows
  const snap = await getDoc(pRef);
  const startedAt = snap.data()?.sessions?.[sessionNumber]?.startedAt;
  if (!startedAt) throw new Error("Failed to stamp startedAt");

  // 3) pre-compute the next session window, but DO NOT advance yet
  const next = sessionNumber + 1;
  if (next <= 3) {
    const patch = {};
    patch[`sessions.${next}.windowOpenAt`] = addHours(startedAt, 48);
    patch[`sessions.${next}.windowCloseAt`] = addHours(startedAt, 72);
    await updateDoc(pRef, patch);
  }
}

// Advance to the next session ONLY on completion.
export async function completeSession({ db, participantId, sessionNumber }) {
  const pRef = doc(db, COLLECTIONS.participants, participantId);
  const patch = {
    [`sessions.${sessionNumber}.completedAt`]: serverTimestamp()
  };

  if (sessionNumber < 3) {
    patch["nextSession"] = sessionNumber + 1;
  } else {
    patch["nextSession"] = "done";
  }

  await updateDoc(pRef, patch);
}

//export async function beginSession({ db, participantId, sessionNumber }) {
//  const pRef = doc(db, COLLECTIONS.participants, participantId);
//  await updateDoc(pRef, { [`sessions.${sessionNumber}.startedAt`]: serverTimestamp(), nextSession: sessionNumber });
//  const snap = await getDoc(pRef);
//  const startedAt = snap.data()?.sessions?.[sessionNumber]?.startedAt;
//  if (!startedAt) throw new Error("Failed to stamp startedAt");
//  const next = sessionNumber + 1;
//  if (next <= 3) {
//    await updateDoc(pRef, {
//      [`sessions.${next}.windowOpenAt`]: addHours(startedAt, 48),
//      [`sessions.${next}.windowCloseAt`]: addHours(startedAt, 72),
//      nextSession: next,
//    });
//  } else {
//    await updateDoc(pRef, { nextSession: "done" });
//  }
//}
//
//export async function completeSession({ db, participantId, sessionNumber }) {
//  const pRef = doc(db, COLLECTIONS.participants, participantId);
//  const patch = { [`sessions.${sessionNumber}.completedAt`]: serverTimestamp() };
//  if (sessionNumber === 3) patch["nextSession"] = "done";
//  await updateDoc(pRef, patch);
//}
