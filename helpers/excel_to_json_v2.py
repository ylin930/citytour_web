#!/usr/bin/env python3
# See conversation for full docstring; trimmed here for brevity.
import os, sys, json, math
import pandas as pd
import re

def canon_city(v):
    """
    Turn values like 'City4', 'City 4', 4, 4.0, '4.0' into 'City4'.
    Leaves strings like 'City0' as-is.
    """
    if v is None:
        return ""
    s = str(v).strip()
    # If it already looks like 'CityX' (any spaces/underscore variants), capture the number
    m = re.search(r"(?:city\s*[_-]?\s*)?(\d+)", s, flags=re.I)
    if m:
        return f"City{int(m.group(1))}"
    # last-ditch: if it's just a number-like string
    try:
        n = int(float(s))
        return f"City{n}"
    except Exception:
        # fallback: remove spaces (so 'City4' stays 'City4')
        return s.replace(" ", "")


REQUIRED_COLS = {
    "session": {"session", "sess"},
    "city": {"city", "session_city", "city_id"},
    "task": {"task", "task_id", "taskname", "task_name"},
    "trial": {"trial", "trial_num", "trial_number"},
    "event_id": {"event_id", "event", "eventid"},
    "correct": {"correct", "answer", "key", "correct_option"},
}
GEN_CITY_COLS = {"gen_city", "gencity", "gen_city_id"}

def norm(s): return str(s).strip().lower().replace(" ", "").replace("-", "_")
def find_col(cols, names):
    lc = {norm(c): c for c in cols}
    for n in names:
        if n in lc: return lc[n]
    return None
def as_int(v):
    try:
        import pandas as pd
        if pd.isna(v): return None
        return int(float(v))
    except Exception:
        return None

def split_version_indices(n):
    if n <= 1: return list(range(n)), list(range(n))
    import math
    mid = math.ceil(n/2.0)
    v1 = list(range(n))
    v2 = list(range(mid, n)) + list(range(0, mid))
    return v1, v2

def resolve_assets(task, media_city, event_id, choices):
    if task in ("gen","pc"):
        mediaType = "video"
        choicesOut = choices[:] if choices else ([event_id]*3 if event_id is not None else [])
        assetsOut = [f"media/{media_city}/animations/{{lang}}/{eid}.mp4" for eid in choicesOut]
        return mediaType, choicesOut, assetsOut
    elif task == "ps":
        mediaType = "image"
        choicesOut = choices[:] if choices else []
        assetsOut = [f"media/{media_city}/locations/{event_id}_{variant}.png" for variant in choicesOut]
        return mediaType, choicesOut, assetsOut
    else:
        return "unknown", [], []

def main():
    in_xlsx = sys.argv[1] if len(sys.argv) > 1 else "master_web.xlsx"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "config"

    if not os.path.exists(in_xlsx):
        print(f"Input Excel not found: {in_xlsx}")
        sys.exit(1)
    os.makedirs(out_dir, exist_ok=True)

    df = pd.read_excel(in_xlsx, sheet_name=0)

    cols = {}
    for key, aliases in REQUIRED_COLS.items():
        c = find_col(df.columns, aliases)
        if c is None:
            print(f"Required column missing: {key}")
            sys.exit(1)
        cols[key] = c
    gen_city_col = find_col(df.columns, GEN_CITY_COLS)

    choice_cols = []
    for k in ("choice1","choice2","choice3"):
        c = find_col(df.columns, {k, k.replace("choice","ch"), k.replace("choice","c")})
        if c: choice_cols.append(c)
    if len(choice_cols) not in (0,3):
        print("Provide 0 or 3 choice columns (choice1/2/3).")
        sys.exit(1)

    norm_rows = []
    for _, r in df.iterrows():
        session = str(r[cols["session"]]).strip()
    
        # ✅ normalize city name like "City4" (no 4.0)
        raw_city = r[cols["city"]]
        city = canon_city(raw_city)
    
        task = str(r[cols["task"]]).strip().lower()
        trial = as_int(r[cols["trial"]])
        event_id = as_int(r[cols["event_id"]])
        correct = as_int(r[cols["correct"]])
    
        if not session or not city or not task or trial is None or correct is None:
            continue
    
        row = {
            "session": session,
            "city": city,
            "task": task,
            "trial": trial,
            "event_id": event_id,
            "correct": correct,
        }
    
        # ✅ fix gen_city normalization too
        if task == "gen":
            gen_city = None
            if gen_city_col:
                val = r[gen_city_col]
                if pd.notna(val):
                    gen_city = canon_city(val)
            row["media_city"] = gen_city if gen_city else city
        else:
            row["media_city"] = city
                
        # ✅ Step 3: attach choices as integers (if the 3 choice columns exist)
        if len(choice_cols) == 3:
            ch = [
                as_int(r[choice_cols[0]]),
                as_int(r[choice_cols[1]]),
                as_int(r[choice_cols[2]]),
            ]
            row["choices"] = ch
        else:
            row["choices"] = None
        
        # ✅ Don’t forget to collect the row
        norm_rows.append(row)



    from collections import defaultdict
    groups = defaultdict(list)
    for row in norm_rows:
        groups[(row["session"], row["city"], row["task"])].append(row)

    manifest = {"generated": [], "created_at": None}

    def build_trials(rows):
        rows = sorted(rows, key=lambda x: x["trial"])
        trials = []
        for rr in rows:
            task = rr["task"]
            media_city = rr["media_city"]
            event_id = rr["event_id"]
            correct_pos = rr["correct"]
            if task in ("gen","pc"):
                choices = rr["choices"] if (rr["choices"] and all(c is not None for c in rr["choices"])) else ([event_id]*3)
                mediaType, _, assets = resolve_assets(task, media_city, event_id, choices)
            elif task=="ps":
                pos = [None,None,None]
                pos[correct_pos-1] = 1
                lure = [2,3]
                for i in range(3):
                    if pos[i] is None:
                        pos[i] = lure.pop(0)
                choices = pos[:]
                mediaType, _, assets = resolve_assets(task, media_city, event_id, choices)
            else:
                mediaType, choices, assets = "unknown", [], []
            trials.append({
                "trial": rr["trial"],
                "event_id": event_id,
                "correct": correct_pos,
                "mediaType": mediaType,
                "mediaCity": media_city,
                "choices": choices,
                "assets": assets
            })
        return trials

    for (session, city, task), rows in groups.items():
        trials = build_trials(rows)
        n = len(trials)
        v1, v2 = split_version_indices(n)
        v1_trials = [trials[i] for i in v1]
        v2_trials = [trials[i] for i in v2]
        s = str(session).replace(" ","")
        c = str(city).replace(" ","")
        t = str(task).lower()
        f1 = os.path.join(out_dir, f"trials_{s}_{c}_{t}_v1.json")
        f2 = os.path.join(out_dir, f"trials_{s}_{c}_{t}_v2.json")
        with open(f1,"w",encoding="utf-8") as fo: json.dump(v1_trials, fo, indent=2, ensure_ascii=False)
        with open(f2,"w",encoding="utf-8") as fo: json.dump(v2_trials, fo, indent=2, ensure_ascii=False)
        manifest["generated"].append({"session":session,"city":city,"task":task,"count":n,"files":[os.path.basename(f1),os.path.basename(f2)]})

    import datetime
    manifest["created_at"] = datetime.datetime.utcnow().isoformat()+"Z"
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fo:
        json.dump(manifest, fo, indent=2, ensure_ascii=False)

    print("Done.")
if __name__=="__main__":
    main()
