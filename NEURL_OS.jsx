import { useState, useEffect, useRef, useMemo } from "react";

/* ============================================================
   CHARGE — The Personal Performance Battery
   Know your energy. Protect your performance.

   Signature: the Charge Cell — a 270° instrument-cluster dial
   of luminous tick segments, styled like a luxury tachometer.
   Higher is better. 100 = full capacity.
   ============================================================ */

const STORAGE_KEY = "charge:v1";

/* ---------- scoring engine (risk model → inverted to Charge) ---------- */

const AFTER_HOURS = [
  { id: "never", label: "Never", risk: 0 },
  { id: "sometimes", label: "1–2 nights", risk: 33 },
  { id: "often", label: "3–4 nights", risk: 66 },
  { id: "daily", label: "Most nights", risk: 100 },
];

const WORK_FEEL = [
  { id: "engaged", label: "Energized", risk: 0 },
  { id: "neutral", label: "Neutral", risk: 30 },
  { id: "drained", label: "Drained", risk: 70 },
  { id: "dreading", label: "Dreading it", risk: 100 },
];

const PRE_BED = [
  { id: "no", label: "Rarely", risk: 0 },
  { id: "sometimes", label: "Some nights", risk: 50 },
  { id: "yes", label: "Every night", risk: 100 },
];

const SYMPTOMS = ["Headaches", "Muscle tension", "Poor appetite", "Racing thoughts", "Trouble focusing"];
const RECOVERY = ["Time with people", "Real breaks", "Fully offline time"];

/* ---------- scoring: 6 subscores + weighted Charge ---------- */

// Workload inputs
const TIME_PRESSURE = [
  { id: "low", label: "Low", risk: 0 },
  { id: "medium", label: "Medium", risk: 25 },
  { id: "high", label: "High", risk: 60 },
  { id: "extreme", label: "Extreme", risk: 100 },
];

const SCHEDULE_CONTROL = [
  { id: "high", label: "High (I control my time)", risk: 0 },
  { id: "medium", label: "Medium", risk: 30 },
  { id: "low", label: "Low", risk: 70 },
  { id: "none", label: "None (completely scheduled)", risk: 100 },
];

const WORK_LIFE_CONFLICT = [
  { id: "low", label: "Low", risk: 0 },
  { id: "medium", label: "Medium", risk: 35 },
  { id: "high", label: "High", risk: 70 },
  { id: "extreme", label: "Extreme", risk: 100 },
];

// Nutrition inputs
const HYDRATION = [
  { id: "poor", label: "Poor (rarely drinking water)", risk: 100 },
  { id: "ok", label: "Okay (some water)", risk: 60 },
  { id: "good", label: "Good (regular hydration)", risk: 0 },
];

const CAFFEINE = [
  { id: "low", label: "Low (minimal caffeine)", risk: 0 },
  { id: "moderate", label: "Moderate (steady use)", risk: 20 },
  { id: "high_crash", label: "High with crashes (over-reliant)", risk: 80 },
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Compute all 6 subscores (0–100, higher = better)
function computeSubscores(a) {
  // Sleep score: quality + consistency
  const sleepHoursDist = Math.abs(a.sleepHours - 7.5); // optimal is 7–8
  const sleepHoursPenalty = Math.min(sleepHoursDist * 15, 50);
  const sleepQualityPenalty = (5 - a.sleepQuality) * 20;
  const sleepScore = Math.max(0, 100 - sleepHoursPenalty - sleepQualityPenalty);

  // Workload score: hours + demand days + pressure + control + conflict
  const hoursPenalty = Math.min(Math.abs(a.totalWorkHours - 45) / 35 * 60, 60);
  const demandDaysPenalty = (a.highDemandDaysCount / 7) * 40;
  const timePressureRisk = TIME_PRESSURE.find((o) => o.id === a.timePressure)?.risk ?? 25;
  const scheduleControlRisk = SCHEDULE_CONTROL.find((o) => o.id === a.scheduleControl)?.risk ?? 30;
  const workLifeRisk = WORK_LIFE_CONFLICT.find((o) => o.id === a.workLifeConflict)?.risk ?? 35;
  const workloadScore = Math.max(0, 100 - (hoursPenalty + demandDaysPenalty + (timePressureRisk + scheduleControlRisk + workLifeRisk) / 3));

  // Recovery/movement score: days exercised + recovery activities
  const movementDays = Math.min(a.exerciseDays, 5); // cap at 5
  const movementScore = (movementDays / 5) * 70 + (a.recovery.length / RECOVERY.length) * 30;

  // Emotional/mental score: stress level + symptoms + work feeling
  const stressRisk = a.stressLevel * 10; // 1–10 → 10–100
  const symptomRisk = (a.symptoms.length / SYMPTOMS.length) * 100;
  const workFeelRisk = WORK_FEEL.find((o) => o.id === a.workFeel)?.risk ?? 30;
  const emotionalScore = Math.max(0, 100 - ((stressRisk + symptomRisk + workFeelRisk) / 3));

  // Focus/deep work score: screen time + pre-bed screen + caffeine crashes
  const screenPenalty = Math.min((a.screenHours - 4) / 8 * 60, 60);
  const preBedRisk = PRE_BED.find((o) => o.id === a.preBed)?.risk ?? 50;
  const caffeineRisk = CAFFEINE.find((o) => o.id === a.caffeinePattern)?.risk ?? 20;
  const focusScore = Math.max(0, 100 - (screenPenalty + preBedRisk / 2 + caffeineRisk / 2));

  // Nutrition score: meal balance + processed food + hydration
  const balancedDaysBonus = (a.nutritionBalancedMealsDays / 7) * 60;
  const processedDaysPenalty = (a.nutritionHighProcessedDays / 7) * 40;
  const hydrationRisk = HYDRATION.find((o) => o.id === a.hydrationQuality)?.risk ?? 60;
  const nutritionScore = Math.round(clamp(100 - hydrationRisk / 2 - processedDaysPenalty + balancedDaysBonus, 0, 100));

  return {
    Recharge: Math.round(sleepScore),
    Load: Math.round(workloadScore),
    Restoration: Math.round(movementScore),
    "Stress Load": Math.round(emotionalScore),
    Attention: Math.round(focusScore),
    Fuel: Math.round(nutritionScore),
  };
}

// Compute final Charge with new weights
function computeCharge(subscores, prevCharge) {
  const charge =
    0.30 * subscores.Recharge +
    0.25 * subscores.Load +
    0.20 * subscores.Restoration +
    0.15 * subscores["Stress Load"] +
    0.10 * subscores.Attention +
    0.05 * subscores.Fuel;

  let final = Math.round(charge);
  // Momentum: falling trajectory is riskier
  if (prevCharge != null) final += (final - prevCharge) * 0.15;
  return Math.round(clamp(final, 0, 100));
}

// Find the weakest dimension for commitment targeting
function findPrimaryDrag(subscores) {
  if (!subscores || Object.keys(subscores).length === 0) return "Sleep";
  const [name] = Object.entries(subscores).sort((a, b) => a[1] - b[1])[0];
  return name;
}

/* ---------- PERFORMANCE METRICS ---------- */

// Compute Performance Ratio: output efficiency (tasks per hour)
function computePerformanceRatio(tasksCompleted, hoursWorked) {
  if (hoursWorked === 0) return 0;
  return Math.round((tasksCompleted / hoursWorked) * 100) / 100;
}

// Compute Cognitive Load score (0–100, lower is better)
function computeCognitiveLoad(openDecisions, contextSwitches, deepWorkBlocks, totalWorkHours) {
  // Optimal ranges:
  // Open decisions: 5–8 is safe. Each above 15 = +10 risk. Below 5 = -5 efficiency cost.
  // Context switches: <8/day is flow state. >15/day = cognitive overload.
  // Deep work blocks: 3+ per week is healthy. <2 = concerning.
  
  let load = 50; // baseline
  
  // Decision overload penalty
  if (openDecisions > 15) {
    load += (openDecisions - 15) * 2; // each decision above 15 adds 2 points
  }
  
  // Context switch tax
  const switchesPerDay = totalWorkHours > 0 ? contextSwitches / 5 : 0;
  if (switchesPerDay > 10) {
    load += (switchesPerDay - 10) * 3;
  } else if (switchesPerDay < 5) {
    load -= 5; // good focus
  }
  
  // Deep work deficit
  if (deepWorkBlocks < 2) {
    load += 15;
  } else if (deepWorkBlocks >= 4) {
    load -= 10;
  }
  
  return Math.round(clamp(load, 0, 100));
}

// Analyze what commitments actually moved the needle
function analyzeCommitmentImpact(history) {
  if (history.length < 2) return [];
  
  const impacts = [];
  
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    
    if (prev.commitmentName && prev.commitmentName !== curr.commitmentName) {
      const chargeDelta = curr.charge - prev.charge;
      impacts.push({
        commitment: prev.commitmentName,
        chargeDelta,
        week: i,
        success: chargeDelta >= 0,
      });
    }
  }
  
  // Aggregate by commitment name
  const aggregated = {};
  impacts.forEach(({ commitment, chargeDelta }) => {
    if (!aggregated[commitment]) {
      aggregated[commitment] = { total: 0, count: 0, max: -100, min: 100 };
    }
    aggregated[commitment].total += chargeDelta;
    aggregated[commitment].count += 1;
    aggregated[commitment].max = Math.max(aggregated[commitment].max, chargeDelta);
    aggregated[commitment].min = Math.min(aggregated[commitment].min, chargeDelta);
  });
  
  // Convert to array with averages
  return Object.entries(aggregated).map(([name, data]) => ({
    name,
    avgImpact: Math.round(data.total / data.count),
    maxImpact: data.max,
    minImpact: data.min,
    attempts: data.count,
    successRate: Math.round((impacts.filter(i => i.commitment === name && i.success).length / data.count) * 100),
  }));
}

// Personal formula: which factors move the needle most for this user
function getPersonalFormula(history) {
  if (history.length < 4) return null;
  
  const commitmentImpacts = analyzeCommitmentImpact(history);
  if (commitmentImpacts.length === 0) return null;
  
  return commitmentImpacts.sort((a, b) => b.avgImpact - a.avgImpact).slice(0, 3);
}

/* ---------- states & context ---------- */

const STATES = [
  { name: "Peak", min: 81, max: 100, desc: "Full capacity. Systems primed — deploy it on what matters most." },
  { name: "Strong", min: 66, max: 80, desc: "High capacity with headroom. Protect recovery to reach Peak." },
  { name: "Recovering", min: 46, max: 65, desc: "Capacity is rebuilding. Managing load strategically pays off this week." },
  { name: "Rebuild", min: 0, max: 45, desc: "Reserves are low. Recovery is your highest-leverage performance move." },
];

const stateOf = (c) => STATES.find((s) => c >= s.min) || STATES[STATES.length - 1];

// Modeled averages by age bracket (mid-career strain peaks; ends of range run higher)
const AGE_BRACKETS = [
  { id: "18-24", label: "18–24", avg: 54 },
  { id: "25-34", label: "25–34", avg: 49 },
  { id: "35-44", label: "35–44", avg: 47 },
  { id: "45-54", label: "45–54", avg: 50 },
  { id: "55+", label: "55+", avg: 56 },
];
const AVG_CHARGE = 52; // fallback: typical working adult
const bracketOf = (id) => AGE_BRACKETS.find((b) => b.id === id) || null;
const avgFor = (ageBracket) => bracketOf(ageBracket)?.avg ?? AVG_CHARGE;
const cohortLabel = (ageBracket) => {
  const b = bracketOf(ageBracket);
  return b ? `adults ${b.label}` : "working adults";
};
const PEAK_MIN = 81;

// Charge color: low = signal red → amber → luminous ion teal
function chargeHue(c) {
  return c <= 50 ? 8 + (c / 50) * 32 : 40 + ((c - 50) / 50) * 132;
}
const chargeColor = (c, s = 85, l = 58) => `hsl(${chargeHue(c)}, ${s}%, ${l}%)`;

// Percentile vs a modeled cohort ~ N(52, 15)
function percentile(c, avg = AVG_CHARGE) {
  const z = (c - avg) / 15;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const erf =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  const p = 0.5 * (1 + Math.sign(z) * erf);
  return Math.round(clamp(p * 100, 1, 99));
}

// Risk indicator: output level + sustainability  
function getRiskIndicator(charge, forecast) {
  // Output level based on Charge score
  const outputLabel = charge >= 81 ? "High output" : charge >= 66 ? "Moderate output" : charge >= 46 ? "Declining output" : "Low output";
  
  // Risk based on trajectory
  const rising = forecast && forecast.rising;
  const falling = forecast && !forecast.rising && forecast.projected < charge;
  
  let riskLabel;
  if (charge >= 75 && (rising || !falling)) {
    riskLabel = "sustainable";
  } else if (charge >= 55) {
    riskLabel = falling ? "watch" : "moderate";
  } else {
    riskLabel = falling ? "burnout trajectory" : "monitor";
  }
  
  const riskColor = riskLabel === "sustainable" ? "var(--ion)" : riskLabel === "watch" || riskLabel === "monitor" ? "#FFB84D" : "#E63946";
  
  return { outputLabel, riskLabel, riskColor };
}

/* ---------- performance adjustments (by weakest input) ---------- */

const ADJUSTMENTS = {
  Recharge: {
    title: "Set a performance-grade sleep window",
    tip: "Lock a fixed wake time for 7 days — consistency raises baseline NEURL Score faster than extra hours. Usually adds +5–10% over 3 weeks.",
  },
  Load: {
    title: "Delete one recurring obligation that doesn't move your top goals",
    tip: "Load is compressing your capacity. Identify one recurring commitment to delegate, defer, or delete before Monday. Usually adds +5–10% over 3 weeks.",
  },
  Restoration: {
    title: "Lock three non-negotiable physical recovery blocks",
    tip: "Movement and restoration are limiting. Commit to 3+ sessions of intentional exercise or restorative activity this week; treat them like investor meetings. Usually adds +5–10% over 3 weeks.",
  },
  "Stress Load": {
    title: "Install a hard stop",
    tip: "Stress load is high. Set one non-negotiable end to your workday this week and defend it like a client meeting. Usually adds +5–10% over 3 weeks.",
  },
  Attention: {
    title: "Build a shutdown buffer",
    tip: "Screen exposure is draining overnight attention. A 30-minute screen-free buffer before sleep is the highest-leverage adjustment. Usually adds +5–10% over 3 weeks.",
  },
  Fuel: {
    title: "Commit to regular, balanced meals",
    tip: "Nutrition is your limiting factor. Commit to regular, balanced meals 6 days this week — sustained energy beats caffeine crashes. Usually adds +5–10% over 3 weeks.",
  },
};

/* ---------- questions (performance inputs) ---------- */

const QUESTIONS = [
  { key: "sleepHours", domain: "Sleep", title: "Hours of sleep on a typical night this week?", type: "slider", min: 3, max: 10, step: 0.5, unit: "hrs" },
  { key: "sleepQuality", domain: "Sleep", title: "How recharged did you wake up?", type: "scale", labels: ["Empty", "Low", "Okay", "Good", "Full"] },
  
  { key: "totalWorkHours", domain: "Workload", title: "Total hours worked or studied this week?", type: "slider", min: 20, max: 80, step: 1, unit: "hrs" },
  { key: "highDemandDaysCount", domain: "Workload", title: "How many days felt back-to-back or intense?", type: "slider", min: 0, max: 7, step: 1, unit: "days" },
  { key: "timePressure", domain: "Workload", title: "How much time pressure did you feel?", type: "chips", options: TIME_PRESSURE },
  { key: "scheduleControl", domain: "Workload", title: "How much control do you have over your schedule?", type: "chips", options: SCHEDULE_CONTROL },
  { key: "workLifeConflict", domain: "Workload", title: "How much did work conflict with personal time?", type: "chips", options: WORK_LIFE_CONFLICT },
  
  { key: "stressLevel", domain: "Emotional", title: "How stressed did you feel on most days? (1 = calm, 10 = maxed out)", type: "slider", min: 1, max: 10, step: 1, unit: "/ 10" },
  { key: "symptoms", domain: "Emotional", title: "Any physical stress signals this week?", subtitle: "Select all that apply", type: "multi", options: SYMPTOMS, none: "None of these" },
  { key: "workFeel", domain: "Emotional", title: "Starting work most mornings, you felt…", type: "chips", options: WORK_FEEL },
  
  { key: "exerciseDays", domain: "Recovery", title: "How many days did you exercise or move intentionally?", type: "slider", min: 0, max: 7, step: 1, unit: "days" },
  { key: "recovery", domain: "Recovery", title: "Which recovery activities happened this week?", subtitle: "Select all that apply", type: "multi", options: RECOVERY, none: "None of these" },
  
  { key: "screenHours", domain: "Focus", title: "Average daily screen time?", type: "slider", min: 2, max: 14, step: 0.5, unit: "hrs" },
  { key: "preBed", domain: "Focus", title: "Screens in the 30 minutes before sleep?", type: "chips", options: PRE_BED },
  
  { key: "nutritionBalancedMealsDays", domain: "Nutrition", title: "Days with regular, balanced meals?", subtitle: "A balanced meal has protein + whole grains + vegetables. Not skipped meals or just snacks.", type: "slider", min: 0, max: 7, step: 1, unit: "days" },
  { key: "nutritionHighProcessedDays", domain: "Nutrition", title: "Days mostly fast food or ultra-processed?", subtitle: "Fast food, instant noodles, packaged snacks, sugary drinks. Count days where these were most of your eating.", type: "slider", min: 0, max: 7, step: 1, unit: "days" },
  { key: "hydrationQuality", domain: "Nutrition", title: "How was your hydration this week?", subtitle: "Good = consistent water intake throughout the day. Okay = some water, but forgetting often. Poor = rarely drank water.", type: "chips", options: HYDRATION },
  { key: "caffeinePattern", domain: "Nutrition", title: "Your caffeine use was…", type: "chips", options: CAFFEINE },
  
  { key: "tasksCompleted", domain: "Performance", title: "High-leverage tasks or goals completed this week?", subtitle: "Count meaningful work: shipped features, closed deals, solved hard problems. Not meetings or admin.", type: "slider", min: 0, max: 20, step: 1, unit: "tasks" },
  { key: "outputQuality", domain: "Performance", title: "Quality of work this week?", type: "chips", options: [
    { id: "excellent", label: "Excellent — best-quality work" },
    { id: "good", label: "Good — solid, ship-ready" },
    { id: "okay", label: "Okay — functional, some rework" },
    { id: "slipping", label: "Slipping — errors, rework needed" },
    { id: "compromised", label: "Compromised — rushed, low bar" }
  ]},
  
  { key: "openDecisions", domain: "Cognitive Load", title: "How many open decisions/projects are you juggling?", subtitle: "Estimate: decisions you're holding, projects in flight, ideas you haven't closed. Typical range: 5–15.", type: "slider", min: 0, max: 50, step: 1, unit: "decisions" },
  { key: "contextSwitches", domain: "Cognitive Load", title: "How many times per day did you switch between tasks/meetings/chats?", subtitle: "Rough estimate: Count major focus shifts. High switching = decreased attention.", type: "slider", min: 2, max: 20, step: 1, unit: "switches" },
  { key: "deepWorkBlocks", domain: "Cognitive Load", title: "Uninterrupted deep work blocks this week?", subtitle: "Count blocks of 90+ minutes of focused work without distractions.", type: "slider", min: 0, max: 15, step: 1, unit: "blocks" },
];

const DEFAULT_ANSWERS = {
  ageBracket: null,
  sleepHours: 7, sleepQuality: 3,
  totalWorkHours: 45, highDemandDaysCount: 2, timePressure: null, scheduleControl: null, workLifeConflict: null,
  stressLevel: 5, symptoms: [], workFeel: null,
  exerciseDays: 3, recovery: [],
  screenHours: 6, preBed: null,
  nutritionBalancedMealsDays: 4, nutritionHighProcessedDays: 1, hydrationQuality: null, caffeinePattern: null,
  tasksCompleted: 5, outputQuality: null,
  openDecisions: 8, contextSwitches: 10, deepWorkBlocks: 3,
};

/* ---------- storage ---------- */

async function loadState() {
  try {
    const r = await window.storage.get(STORAGE_KEY);
    const s = r ? JSON.parse(r.value) : {};
    return { 
      history: s.history || [], 
      user: s.user || null, 
      profile: s.profile || {}, 
      activeCommitment: s.activeCommitment || null 
    };
  } catch {
    return { history: [], user: null, profile: {}, activeCommitment: null };
  }
}
async function saveState(state) {
  try { await window.storage.set(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.error("save failed", e); }
}

function streakOf(history) {
  if (!history.length) return 0;
  let streak = 1;
  for (let i = history.length - 1; i > 0; i--) {
    const gap = (new Date(history[i].date) - new Date(history[i - 1].date)) / 86400000;
    if (gap <= 9) streak++; else break;
  }
  return streak;
}

const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/* ---------- the Charge Cell (signature dial) ---------- */

function ChargeCell({ charge, size = 260, animate = true, pulse = false }) {
  const [shown, setShown] = useState(animate ? 0 : charge);
  useEffect(() => {
    if (!animate) { setShown(charge); return; }
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) { setShown(charge); return; }
    let raf, start;
    const dur = 1500;
    const tick = (t) => {
      if (!start) start = t;
      const p = Math.min((t - start) / dur, 1);
      setShown(Math.round((1 - Math.pow(1 - p, 3)) * charge));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [charge, animate]);

  const cx = size / 2, cy = size / 2;
  const R1 = size / 2 - 8, R2 = size / 2 - 26;
  const N = 48;
  const filled = Math.round((shown / 100) * N);
  const hue = chargeHue(shown);
  const col = `hsl(${hue}, 85%, 58%)`;
  const st = stateOf(shown);

  const ticks = [];
  for (let i = 0; i < N; i++) {
    const ang = ((135 + (270 * i) / (N - 1)) * Math.PI) / 180;
    const x1 = cx + R2 * Math.cos(ang), y1 = cy + R2 * Math.sin(ang);
    const x2 = cx + R1 * Math.cos(ang), y2 = cy + R1 * Math.sin(ang);
    const on = i < filled;
    ticks.push(
      <line
        key={i} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={on ? col : "rgba(255,255,255,0.09)"}
        strokeWidth={3.2} strokeLinecap="round"
        style={on ? { filter: `drop-shadow(0 0 5px hsla(${hue},90%,60%,0.7))` } : undefined}
      />
    );
  }

  return (
    <div className={`cell-wrap ${pulse ? "pulsing" : ""}`} style={{ width: size, height: size }}>
      <div className="cell-halo" style={{ background: `radial-gradient(circle, hsla(${hue},90%,55%,0.14) 0%, transparent 65%)` }} />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="cell-svg">{ticks}</svg>
      <div className="cell-center">
        <div className="cell-eyebrow">Your NEURL Score</div>
        <div className="cell-num" style={{ color: col }}>
          {shown}<span className="cell-pct">%</span>
        </div>
        <div className="cell-state">{st.name}</div>
      </div>
    </div>
  );
}

/* ---------- home-screen context: reading the system ---------- */

function ChargeContext({ charge, ageBracket }) {
  const avg = avgFor(ageBracket);
  const cohort = cohortLabel(ageBracket);
  const pos = (v) => `${clamp(v, 0, 100)}%`;
  const tagPos = (v) => `${clamp(v, 9, 91)}%`; // keep labels inside the card
  return (
    <div className="card">
      <div className="eyebrow">Reading your Charge</div>
      <p className="ctx-p">
        Charge is your performance capacity — the battery your habits build. <strong>100 is full
        capacity</strong>, primed to perform. The average for {cohort} is around{" "}
        <strong>{avg}%</strong>. Sustained performance lives at <strong>{PEAK_MIN}%+</strong> —
        that's the zone to build toward and defend. <strong>Burnout is what happens when you run negative for too long.</strong>
      </p>
      <div className="gauge">
        <div className="gauge-tag you-tag" style={{ left: tagPos(charge), color: chargeColor(charge, 85, 66) }}>
          You · {charge}
        </div>
        <div className="gauge-track" />
        <div className="gauge-marker you" style={{ left: pos(charge), background: chargeColor(charge) }} />
        <div className="gauge-marker avg" style={{ left: pos(avg) }} />
        <div className="gauge-tag avg-tag" style={{ left: tagPos(avg) }}>
          Typical · {avg}
        </div>
      </div>
      <div className="legend">
        {STATES.map((s) => (
          <div className={`legend-row ${charge >= s.min && charge <= s.max ? "current" : ""}`} key={s.name}>
            <span className="legend-dot" style={{ background: chargeColor((s.min + s.max) / 2) }} />
            <span className="legend-name">{s.name}</span>
            <span className="legend-range">{s.min}–{s.max}</span>
            <span className="legend-desc">{s.desc}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- dimensions ---------- */

const DIM_META = {
  Energy: { sub: "Available physical and mental energy" },
  Focus: { sub: "Cognitive performance and concentration" },
  Recovery: { sub: "How effectively you're rebuilding" },
  Resilience: { sub: "Capacity to perform under pressure" },
};

function DimGrid({ dims }) {
  return (
    <div className="dim-grid">
      {Object.entries(dims).map(([name, v]) => (
        <div className="dim-card" key={name}>
          <MiniArc value={v} />
          <div className="dim-name">{name}</div>
          <div className="dim-sub">{DIM_META[name].sub}</div>
        </div>
      ))}
    </div>
  );
}

function MiniArc({ value }) {
  const size = 74, r = 30, c = 2 * Math.PI * r;
  const off = c - (value / 100) * c * 0.75;
  const col = chargeColor(value);
  return (
    <div className="mini-wrap">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={37} cy={37} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={5}
          strokeDasharray={`${c * 0.75} ${c}`} strokeLinecap="round" transform="rotate(135 37 37)" />
        <circle cx={37} cy={37} r={r} fill="none" stroke={col} strokeWidth={5}
          strokeDasharray={`${c * 0.75} ${c}`} strokeDashoffset={off} strokeLinecap="round"
          transform="rotate(135 37 37)"
          style={{ filter: `drop-shadow(0 0 4px ${col})`, transition: "stroke-dashoffset .8s cubic-bezier(.4,0,.2,1)" }} />
      </svg>
      <div className="mini-num" style={{ color: col }}>{value}</div>
    </div>
  );
}

/* ---------- forecast ---------- */

function buildForecast(history, subscores) {
  // Guard: if subscores missing, return default forecast
  if (!subscores || Object.keys(subscores).length === 0) {
    return { projected: 50, dragName: "Recharge", dragVal: 50, narrative: "Check back next week for your forecast.", rising: false };
  }
  
  const last = history[history.length - 1];
  const pts = history.slice(-3).map((e) => e.charge);
  let projected = last.charge;
  if (pts.length >= 2) {
    const slope = (pts[pts.length - 1] - pts[0]) / (pts.length - 1);
    projected = Math.round(clamp(last.charge + slope, 0, 100));
  }
  const sorted = Object.entries(subscores).sort((a, b) => a[1] - b[1]);
  const [dragName, dragVal] = sorted[0];
  const [drag2Name] = sorted[1];
  const rising = projected > last.charge;
  const flat = projected === last.charge;

  const dragPhrase = {
    Recharge: "recharge capacity is depleting",
    Load: "structural load is unsustainable",
    Restoration: "recovery is insufficient",
    "Stress Load": "stress load remains elevated",
    Attention: "attention is compromised",
    Fuel: "fuel intake is inconsistent",
  };

  let narrative;
  if (history.length < 2) {
    narrative = `Baseline set at ${last.charge}%. Track weekly to build your personal pattern. Trends become visible after 3 check-ins.`;
  } else if (rising) {
    narrative = `Trending toward ${projected}% next week. You're building positive momentum — protect your recovery commitments to sustain it.`;
  } else if (flat) {
    narrative = `Holding near ${projected}% next week. ${cap(dragPhrase[dragName])} is your highest-leverage adjustment point.`;
  } else {
    narrative = `Trending toward ${projected}% next week. This is the pattern that turns into burnout in 4–6 weeks if unaddressed. One targeted adjustment now changes the trajectory.`;
  }
  return { projected, dragName, dragVal, narrative, rising };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---------- share ---------- */

function shareText(charge, best) {
  const st = stateOf(charge);
  return (
    `My NEURL Score this week: ${charge}% ⚡\n` +
    `Operating in ${st.name} mode.\n\n` +
    `NEURL OS is an AI-powered performance intelligence system.\n` +
    `Weekly calibration → Predictive NEURL Score → Performance optimization.\n` +
    `Track what matters: productivity, focus, capacity, resilience.\n\n` +
    `2-minute weekly calibration. See how you compare to your peers.\n` +
    `Join at https://neurl.os`
  );
}

function ShareCard({ charge, best }) {
  const [copied, setCopied] = useState(false);
  const text = shareText(charge, best);
  
  const shareViaText = () => {
    const msg = encodeURIComponent(text);
    window.location.href = `sms:?body=${msg}`;
  };
  
  const shareViaEmail = () => {
    const mailto = `mailto:?subject=${encodeURIComponent(`My Charge this week: ${charge}% ⚡`)}&body=${encodeURIComponent(text)}`;
    window.location.href = mailto;
  };
  
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  };
  
  return (
    <div className="card center-text">
      <div className="eyebrow">Performance Leaderboard</div>
      <p className="card-p">
        High performers thrive on accountability. Share your NEURL Score with peers, teams, and friends. Weekly rankings. Monthly improvement streaks. Push each other higher.
      </p>
      <div className="share-row">
        <button className="btn-primary share-btn" onClick={shareViaText}>
          Share via Text
        </button>
        <button className="btn-secondary share-btn" onClick={shareViaEmail}>
          Share via Email
        </button>
        <button className="btn-secondary share-btn" onClick={copyInvite}>
          {copied ? "Copied ✓" : "Copy Link"}
        </button>
      </div>
      {copied && (
        <p className="fine" style={{ marginTop: 12, color: "var(--ink)", opacity: 1 }}>
          Paste into any message to share your NEURL Score
        </p>
      )}
    </div>
  );
}

/* ---------- commitment tracking ---------- */

function CompletionCheck({ commitment, onComplete, onSkip }) {
  const [days, setDays] = useState(commitment.targetDays);
  return (
    <div className="fade-in">
      <button className="btn-ghost" onClick={onSkip}>Skip this</button>
      <div className="center-col" style={{ marginTop: 40 }}>
        <div className="eyebrow">Last week's commitment</div>
        <h2 className="q-title">How many days did you complete this?</h2>
        <p className="q-sub">{commitment.name}</p>
        <div className="slider-block" style={{ marginTop: 40 }}>
          <div className="slider-val">{days} <span className="slider-unit">/ {commitment.targetDays} days</span></div>
          <input type="range" min={0} max={commitment.targetDays} value={days}
            onChange={(e) => setDays(parseInt(e.target.value))} className="slider" />
          <div className="slider-ends"><span>0</span><span>{commitment.targetDays}</span></div>
        </div>
        <button className="btn-primary wide" onClick={() => onComplete(days)} style={{ marginTop: 40 }}>
          {days >= commitment.targetDays ? "You crushed it! ✓" : days >= commitment.targetDays * 0.7 ? "Strong week ✓" : "Log it"}
        </button>
      </div>
    </div>
  );
}

function StreakBadge({ commitment }) {
  if (!commitment || !commitment.streakCount) return null;
  const s = commitment.streakCount;
  const flames = Math.min(s, 5);
  return (
    <div className="streak-badge">
      {"🔥".repeat(flames)} <span className="streak-text">{s}-week commitment streak</span>
    </div>
  );
}

/* ============================================================ */

export default function App() {
  const [view, setView] = useState("loading");
  const [state, setState] = useState({ history: [], user: null, profile: {}, activeCommitment: null });
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({ ...DEFAULT_ANSWERS });
  const [commitmentChoice, setCommitmentChoice] = useState(null);
  const [lastCheckInDate, setLastCheckInDate] = useState(null);
  const [dir, setDir] = useState(1);
  const topRef = useRef(null);

  useEffect(() => {
    loadState().then((s) => {
      setState(s);
      setView(s.history.length ? "today" : "welcome");
    });
  }, []);

  const latest = state.history[state.history.length - 1] || null;
  const prev = state.history[state.history.length - 2] || null;
  const daysSince = latest ? Math.floor((Date.now() - new Date(latest.date)) / 86400000) : null;
  const dueIn = latest ? Math.max(0, 7 - daysSince) : 0;
  const streak = state.user ? streakOf(state.history) : null; // streaks only tracked when logged in
  const best = state.history.length ? Math.max(...state.history.map((e) => e.charge)) : null;
  const bracket = state.profile?.ageBracket || null;
  const avg = avgFor(bracket);
  const cohort = cohortLabel(bracket);

  // Login form
  const [loginName, setLoginName] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginReturn, setLoginReturn] = useState("welcome");

  const openLogin = (returnTo) => { setLoginReturn(returnTo); setView("login"); };
  const doLogin = async () => {
    if (!loginName.trim() || !loginEmail.trim()) return;
    const nextState = { ...state, user: { name: loginName.trim(), email: loginEmail.trim() } };
    setState(nextState);
    await saveState(nextState);
    setView(loginReturn);
  };
  const logout = async () => {
    const nextState = { ...state, user: null };
    setState(nextState);
    await saveState(nextState);
  };

  // Ask age once; afterwards it's remembered in the profile
  const questions = useMemo(() => {
    const ageQ = {
      key: "ageBracket", domain: "Profile",
      title: "What's your age range?",
      subtitle: "Your NEURL Score is compared against the average for your age group",
      type: "chips", options: AGE_BRACKETS,
    };
    return bracket ? QUESTIONS : [ageQ, ...QUESTIONS];
  }, [bracket]);

  const q = questions[step];
  const answered = (qq) => (qq.type === "chips" ? answers[qq.key] != null : true);

  const next = () => {
    setDir(1);
    if (step < questions.length - 1) setStep(step + 1);
    else finish();
    topRef.current?.scrollIntoView({ behavior: "smooth" });
  };
  const back = () => { setDir(-1); setStep(Math.max(0, step - 1)); };

  const finish = async () => {
    const subscores = computeSubscores(answers);
    const charge = computeCharge(subscores, latest?.charge ?? null);
    const primaryDrag = findPrimaryDrag(subscores);
    
    // Compute performance metrics
    const performanceRatio = computePerformanceRatio(answers.tasksCompleted, answers.totalWorkHours);
    const cognitiveLoad = computeCognitiveLoad(answers.openDecisions, answers.contextSwitches, answers.deepWorkBlocks, answers.totalWorkHours);
    
    const entry = {
      date: new Date().toISOString(),
      charge,
      subscores,
      primaryDrag,
      performanceRatio, // tasks per hour worked
      outputQuality: answers.outputQuality,
      tasksCompleted: answers.tasksCompleted,
      cognitiveLoad, // 0–100, lower is better
      openDecisions: answers.openDecisions,
      contextSwitches: answers.contextSwitches,
      deepWorkBlocks: answers.deepWorkBlocks,
      committedToIntervention: null,
      commitmentName: null,
      commitmentTargetDays: 5,
    };
    const profile = answers.ageBracket ? { ...state.profile, ageBracket: answers.ageBracket } : state.profile;
    const nextState = { ...state, profile, history: [...state.history, entry] };
    setState(nextState);
    setCommitmentChoice(null);
    setView("reveal");
    await saveState(nextState);
  };

  const commitToIntervention = async (interventionName) => {
    const entry = state.history[state.history.length - 1];
    entry.committedToIntervention = true;
    entry.commitmentName = interventionName;
    entry.commitmentTargetDays = 5;
    
    const nextCommitment = {
      name: interventionName,
      startDate: new Date().toISOString(),
      targetDays: 5,
      streakCount: (state.activeCommitment?.streakCount ?? 0) + 1,
      completionDays: null,
    };
    
    const nextState = { ...state, activeCommitment: nextCommitment };
    setState(nextState);
    await saveState(nextState);
    setCommitmentChoice(interventionName);
  };

  const startCheckin = () => {
    setAnswers({ ...DEFAULT_ANSWERS });
    setStep(0); setDir(1);
    // If they have an active commitment, show completion check first
    if (state.activeCommitment) setView("completion-check");
    else setView("checkin");
  };

  const handleCompletionLogged = async (completionDays) => {
    // Update commitment with completion and streak
    const commitment = state.activeCommitment;
    const completed = completionDays >= commitment.targetDays;
    const newStreak = completed ? (commitment.streakCount || 0) + 1 : 0;
    const updatedCommitment = { ...commitment, completionDays, streakCount: newStreak };
    
    // If streak broken, clear active commitment; otherwise keep it for next week
    const nextCommitment = completed ? updatedCommitment : null;
    
    const nextState = { ...state, activeCommitment: nextCommitment };
    setState(nextState);
    await saveState(nextState);
    setView("checkin");
  };

  const set = (key, val) => setAnswers((a) => ({ ...a, [key]: val }));
  const toggle = (key, item) =>
    setAnswers((a) => ({ ...a, [key]: a[key].includes(item) ? a[key].filter((x) => x !== item) : [...a[key], item] }));

  const forecast = useMemo(
    () => (latest ? buildForecast(state.history, latest.subscores) : null),
    [state.history, latest]
  );

  const opportunity = useMemo(() => {
    if (!latest || !latest.subscores) return null;
    const [topDim] = Object.entries(latest.subscores).sort((a, b) => b[1] - a[1])[0];
    const map = {
      Sleep: "Your sleep foundation is strong. Use this week to tackle harder projects.",
      Workload: "Your workload is manageable. This is your window to take on stretch assignments.",
      Recovery: "Your recovery systems are working. You can sustain more load this week.",
      Emotional: "Your emotional resilience is high. If there's a hard conversation to have, this is the week.",
      Focus: "Your focus is sharp. Block deep-work time and ship your best work.",
      Nutrition: "Your nutrition is solid. Your sustained energy will support high performance.",
    };
    return map[topDim];
  }, [latest]);

  const risk = useMemo(() => {
    if (!latest || !forecast) return null;
    const map = {
      Sleep: "Sleep debt may cut afternoon output. Guard tonight's window.",
      Workload: "Structural workload may compress recovery. Watch the evening spillover.",
      Load: "Elevated performance load may reduce cognitive output late in the day. Install one hard stop.",
      Screen: "Screen exposure is taxing overnight recharge. Build a shutdown buffer tonight.",
      Recovery: "Thin recovery volume limits how much load you can absorb this week.",
    };
    return map[forecast.dragName];
  }, [latest, forecast]);

  const topDrivers = useMemo(() => {
    if (!latest || !latest.subscores) return [];
    return Object.entries(latest.subscores).sort((a, b) => a[1] - b[1]).slice(0, 2);
  }, [latest]);

  return (
    <div className="app">
      <style>{CSS}</style>
      <div ref={topRef} />
      <div className="shell">

        {view === "loading" && <div className="loading-dot" />}

        {/* ---------- WELCOME ---------- */}
        {view === "welcome" && (
          <div className="fade-in center-col">
            <div className="wordmark">NEURL OS</div>
            <ChargeCell charge={86} animate={false} size={220} pulse />
            <h1 className="hero-h">The Operating System for Peak Performance</h1>
            <p className="hero-p">
              NEURL OS transforms your weekly habits into a predictive performance model. Get your NEURL Score, forecast next week's capacity, and stay at your best before burnout begins. Designed for ambitious professionals who measure everything—except themselves.
            </p>
            <button className="btn-primary" onClick={startCheckin}>Get Your NEURL Score</button>
            {state.user ? (
              <div className="signed-in">Signed in as {state.user.name} · <button className="link-btn" onClick={logout}>Sign out</button></div>
            ) : (
              <button className="btn-secondary login-btn" onClick={() => openLogin("welcome")}>Log in to save your performance history</button>
            )}
            <div className="fine">2-minute weekly calibration · Your data, private · Login optional</div>

            {/* ---------- WHY IT MATTERS ---------- */}
            <div style={{ marginTop: 48, paddingTop: 32, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
              <div style={{ textAlign: "center", marginBottom: 32 }}>
                <h2 className="hero-h" style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 10, lineHeight: 1.3 }}>Why High Performers Need NEURL OS</h2>
                <p className="hero-p" style={{ fontSize: 14, lineHeight: 1.6 }}>
                  Founders measure revenue. Athletes measure splits. Investors measure returns. But most high-performers never measure the one thing that determines everything: their own operating capacity.
                </p>
              </div>

              {/* Feature Cards */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 32 }} className="feature-grid">
                <div className="card" style={{ borderLeft: `3px solid ${chargeColor(85)}`, paddingLeft: "12px" }}>
                  <div className="eyebrow">Weekly NEURL Score</div>
                  <p className="card-p" style={{ fontSize: 14 }}>Your operating system receives a single, predictive performance metric every week. Not vague. Not aspirational. Measurable.</p>
                </div>
                <div className="card" style={{ borderLeft: `3px solid ${chargeColor(85)}`, paddingLeft: "12px" }}>
                  <div className="eyebrow">AI-Powered Forecast</div>
                  <p className="card-p" style={{ fontSize: 14 }}>Our system analyzes your habits and predicts next week's capacity before it happens. "You're trending toward peak Thursday" or "Decline incoming by Friday."</p>
                </div>
                <div className="card" style={{ borderLeft: `3px solid ${chargeColor(85)}`, paddingLeft: "12px" }}>
                  <div className="eyebrow">Personal Performance Algorithm</div>
                  <p className="card-p" style={{ fontSize: 14 }}>After 4 weeks of calibrations, NEURL OS reveals YOUR formula: which habits move your score most, when you peak, what kills your capacity.</p>
                </div>
                <div className="card" style={{ borderLeft: `3px solid ${chargeColor(85)}`, paddingLeft: "12px" }}>
                  <div className="eyebrow">Performance Leaderboard</div>
                  <p className="card-p" style={{ fontSize: 14 }}>Share your NEURL Score with peers, teams, founders. See weekly rankings. Track monthly improvement streaks. Accountability drives consistency.</p>
                </div>
              </div>

              {/* How It Works */}
              <div style={{ marginBottom: 32 }}>
                <h3 style={{ fontSize: 15, fontWeight: 600, letterSpacing: "0.08em", marginBottom: 24, textAlign: "center", color: "#B0B9C6" }}>HOW IT WORKS</h3>
                <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 20 }}>
                  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.3)", flexShrink: 0, fontFamily: "'Archivo', sans-serif", fontSize: 16, fontWeight: 600, color: "#F2F4F7" }}>1</div>
                    <div>
                      <p className="card-p" style={{ fontSize: 14, marginTop: 0 }}>Complete a 2-minute weekly calibration. Answer 25 questions about your week: sleep, focus, decisions, output, stress, recovery.</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.3)", flexShrink: 0, fontFamily: "'Archivo', sans-serif", fontSize: 16, fontWeight: 600, color: "#F2F4F7" }}>2</div>
                    <div>
                      <p className="card-p" style={{ fontSize: 14, marginTop: 0 }}>AI analyzes your behavioral patterns. Our system maps six performance dimensions and weights them by your personal formula.</p>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 40, height: 40, borderRadius: "50%", border: "1.5px solid rgba(255,255,255,0.3)", flexShrink: 0, fontFamily: "'Archivo', sans-serif", fontSize: 16, fontWeight: 600, color: "#F2F4F7" }}>3</div>
                    <div>
                      <p className="card-p" style={{ fontSize: 14, marginTop: 0 }}>Get your NEURL Score (0–100), this week's forecast, and one high-leverage adjustment. Share your score. Track your trend.</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* The NEURL Score */}
              <div className="card" style={{ marginBottom: 32 }}>
                <div className="eyebrow">The NEURL Score</div>
                <p className="card-p" style={{ fontSize: 14, marginBottom: 20, lineHeight: 1.6 }}>
                  0–100. Higher is better. It measures your operating capacity right now.
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="score-grid">
                  <div style={{ padding: 12, background: "rgba(76, 224, 167, 0.05)", borderRadius: 8, border: "1px solid rgba(76, 224, 167, 0.1)", borderTop: `2px solid ${chargeColor(85)}` }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: chargeColor(85), marginBottom: 6, fontFamily: "'Archivo', sans-serif" }}>81–100</div>
                    <p className="fine" style={{ fontSize: 11, lineHeight: 1.5 }}>Peak. Full capacity. Deploy on your most important work.</p>
                  </div>
                  <div style={{ padding: 12, background: "rgba(255, 184, 77, 0.05)", borderRadius: 8, border: "1px solid rgba(255, 184, 77, 0.1)", borderTop: `2px solid ${chargeColor(70)}` }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: chargeColor(70), marginBottom: 6, fontFamily: "'Archivo', sans-serif" }}>66–80</div>
                    <p className="fine" style={{ fontSize: 11, lineHeight: 1.5 }}>Strong. High capacity. Protect recovery to reach peak.</p>
                  </div>
                  <div style={{ padding: 12, background: "rgba(255, 193, 7, 0.05)", borderRadius: 8, border: "1px solid rgba(255, 193, 7, 0.1)", borderTop: `2px solid ${chargeColor(50)}` }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: chargeColor(50), marginBottom: 6, fontFamily: "'Archivo', sans-serif" }}>46–65</div>
                    <p className="fine" style={{ fontSize: 11, lineHeight: 1.5 }}>Recovering. Manage load strategically this week.</p>
                  </div>
                  <div style={{ padding: 12, background: "rgba(239, 83, 80, 0.05)", borderRadius: 8, border: "1px solid rgba(239, 83, 80, 0.1)", borderTop: `2px solid ${chargeColor(20)}` }}>
                    <div style={{ fontSize: 18, fontWeight: 700, color: chargeColor(20), marginBottom: 6, fontFamily: "'Archivo', sans-serif" }}>0–45</div>
                    <p className="fine" style={{ fontSize: 11, lineHeight: 1.5 }}>Reserves low. Recovery is your highest-leverage move.</p>
                  </div>
                </div>
                <p className="fine" style={{ fontSize: 11, marginTop: 12 }}>Track your NEURL Score weekly. Patterns emerge by week 4. Personal formula by week 8.</p>
              </div>

              {/* Social/Leaderboard Section */}
              <div className="card" style={{ marginBottom: 32 }}>
                <div className="eyebrow">Why Share Your Score</div>
                <p className="card-p" style={{ fontSize: 14 }}>
                  High performers thrive on accountability. Share your NEURL Score with your peers, team, or founders group.
                </p>
                <ul style={{ marginTop: 12, paddingLeft: 0, lineHeight: 1.8, listStyle: "none" }}>
                  <li className="fine" style={{ fontSize: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                      <rect x="2" y="9" width="2" height="5" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <rect x="7" y="6" width="2" height="8" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <rect x="12" y="3" width="2" height="11" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                    </svg>
                    See weekly rankings across your network
                  </li>
                  <li className="fine" style={{ fontSize: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                      <polyline points="2,12 5,8 9,10 14,3" stroke={chargeColor(85)} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                      <polyline points="11,3 14,3 14,6" stroke={chargeColor(85)} strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    Track monthly improvement streaks
                  </li>
                  <li className="fine" style={{ fontSize: 12, marginBottom: 8, display: "flex", alignItems: "center", gap: 10 }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                      <circle cx="8" cy="8" r="6" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <circle cx="8" cy="8" r="3" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <circle cx="8" cy="8" r="1" fill={chargeColor(85)}/>
                    </svg>
                    Compete for personal bests and top percentile
                  </li>
                  <li className="fine" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 10 }}>
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                      <circle cx="5" cy="5" r="2" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <circle cx="11" cy="5" r="2" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <circle cx="8" cy="11" r="2" stroke={chargeColor(85)} strokeWidth="1" fill="none"/>
                      <line x1="6.4" y1="6.4" x2="7.3" y2="9" stroke={chargeColor(85)} strokeWidth="0.8"/>
                      <line x1="9.6" y1="6.4" x2="8.7" y2="9" stroke={chargeColor(85)} strokeWidth="0.8"/>
                    </svg>
                    Push each other to sustained peak performance
                  </li>
                </ul>
                <p className="fine" style={{ marginTop: 12, fontSize: 11 }}>Think: Apple Activity Sharing. WHOOP Teams. Strava leaderboards. But for your operating capacity.</p>
              </div>

              {/* Leaderboard Example/Showcase */}
              <div className="card" style={{ marginBottom: 32, background: "rgba(76, 224, 167, 0.05)", borderTop: "2px solid rgba(76, 224, 167, 0.3)" }}>
                <div className="eyebrow" style={{ color: chargeColor(85) }}>Leaderboard Example</div>
                <p className="card-p" style={{ fontSize: 13, marginBottom: 16 }}>See how it works when you join a group:</p>
                
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <p style={{ fontSize: 11, color: "#8B93A1", marginBottom: 8, textAlign: "center" }}>Weekly Leaderboard (This Week)</p>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                    <span>🥇 Sarah</span>
                    <span style={{ color: chargeColor(85), fontWeight: 700 }}>87%</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                    <span>🥈 You</span>
                    <span style={{ color: chargeColor(70), fontWeight: 700 }}>79%</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6, paddingBottom: 6, borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                    <span>🥉 Marcus</span>
                    <span style={{ color: chargeColor(50), fontWeight: 700 }}>74%</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                    <span>Alex</span>
                    <span style={{ color: "#8B93A1", fontWeight: 700 }}>68%</span>
                  </div>
                </div>

                <p className="fine" style={{ fontSize: 11 }}>Share your score → Friends join → Weekly competition → Everyone improves together. That's the leaderboard.</p>
              </div>

              {/* CTA Section */}
              <div style={{ textAlign: "center", paddingTop: 32, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                <div style={{ width: 60, height: 2, background: chargeColor(85), margin: "0 auto 16px", borderRadius: 1 }} />
                <h2 className="hero-h" style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 10, lineHeight: 1.3 }}>Your Best Week Starts With Understanding Yourself</h2>
                <p className="hero-p" style={{ fontSize: 14, lineHeight: 1.6 }}>
                  Get your NEURL Score in 2 minutes. Then build your baseline over 4 weeks. By month 2, you'll know exactly what moves your needle.
                </p>
                <button className="btn-primary" onClick={startCheckin} style={{ marginTop: 20 }}>Get Your NEURL Score</button>
                <p className="fine" style={{ marginTop: 12, fontSize: 11 }}>No credit card. No login required to start. Data stays private.</p>
              </div>
            </div>
          </div>
        )}

        {/* ---------- LOGIN ---------- */}
        {view === "login" && (
          <div className="fade-in">
            <button className="btn-ghost" onClick={() => setView(loginReturn)}>‹ Back</button>
            <div className="login-block">
              <div className="eyebrow">Log in</div>
              <h2 className="q-title">Save your streak.</h2>
              <p className="q-sub" style={{ marginBottom: 24 }}>
                Logging in keeps your weekly streak counting across visits. Your check-in data stays on this device either way.
              </p>
              <input className="login-input" placeholder="Name" value={loginName}
                onChange={(e) => setLoginName(e.target.value)} />
              <input className="login-input" placeholder="Email" type="email" value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doLogin()} />
              <button className="btn-primary wide" style={{ marginTop: 20 }}
                disabled={!loginName.trim() || !loginEmail.trim()} onClick={doLogin}>
                Log in
              </button>
              <button className="btn-ghost link" onClick={() => setView(loginReturn)}>Continue without logging in</button>
            </div>
          </div>
        )}

        {/* ---------- COMPLETION CHECK ---------- */}
        {view === "completion-check" && state.activeCommitment && (
          <CompletionCheck 
            commitment={state.activeCommitment}
            onComplete={handleCompletionLogged}
            onSkip={() => setView("checkin")}
          />
        )}

        {/* ---------- CHECK-IN ---------- */}
        {view === "checkin" && q && (
          <div className="fade-in">
            <div className="checkin-top">
              <button className="btn-ghost" onClick={() => (step === 0 ? setView(state.history.length ? "today" : "welcome") : back())}>
                ‹ {step === 0 ? "Close" : "Back"}
              </button>
              <div className="progress"><div className="progress-fill" style={{ width: `${((step + 1) / questions.length) * 100}%` }} /></div>
              <span className="progress-num">{step + 1}/{questions.length}</span>
            </div>

            <div key={step} className={dir > 0 ? "slide-l" : "slide-r"}>
              <div className="eyebrow">{q.domain} · Performance input</div>
              <h2 className="q-title">{q.title}</h2>
              {q.subtitle && <p className="q-sub">{q.subtitle}</p>}

              {q.type === "slider" && (
                <div className="slider-block">
                  <div className="slider-val">{answers[q.key]}<span className="slider-unit"> {q.unit}</span></div>
                  <input type="range" min={q.min} max={q.max} step={q.step} value={answers[q.key]}
                    onChange={(e) => set(q.key, parseFloat(e.target.value))} className="slider" />
                  <div className="slider-ends"><span>{q.min}</span><span>{q.max}</span></div>
                </div>
              )}

              {q.type === "scale" && (
                <div className="scale-row">
                  {q.labels.map((lab, i) => (
                    <button key={i} className={`scale-btn ${answers[q.key] === i + 1 ? "on" : ""}`} onClick={() => set(q.key, i + 1)}>
                      <span className="scale-n">{i + 1}</span>
                      <span className="scale-lab">{lab}</span>
                    </button>
                  ))}
                </div>
              )}

              {q.type === "chips" && (
                <div className="chip-col">
                  {q.options.map((o) => (
                    <button key={o.id} className={`chip ${answers[q.key] === o.id ? "on" : ""}`} onClick={() => set(q.key, o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              )}

              {q.type === "multi" && (
                <div className="chip-col">
                  {q.options.map((o) => (
                    <button key={o} className={`chip ${answers[q.key].includes(o) ? "on" : ""}`} onClick={() => toggle(q.key, o)}>
                      {o}
                    </button>
                  ))}
                  <button className={`chip muted ${answers[q.key].length === 0 ? "on" : ""}`} onClick={() => set(q.key, [])}>
                    {q.none}
                  </button>
                </div>
              )}
            </div>

            <button className="btn-primary wide" disabled={!answered(q)} onClick={next}>
              {step === questions.length - 1 ? "Get my NEURL Score" : "Continue"}
            </button>
          </div>
        )}

        {/* ---------- REVEAL ---------- */}
        {view === "reveal" && latest && (
          <div className="fade-in center-col">
            <div className="eyebrow" style={{ marginBottom: 10 }}>This week's reading</div>
            <ChargeCell charge={latest.charge} />
            <p className="state-desc">{stateOf(latest.charge).desc}</p>
            {forecast && (() => {
              const { outputLabel, riskLabel, riskColor } = getRiskIndicator(latest.charge, forecast);
              return (
                <div className="card-p" style={{ marginTop: 12, color: riskColor, fontWeight: 500 }}>
                  This week: {outputLabel}, {riskLabel}
                </div>
              );
            })()}
            <div className="card" style={{ marginTop: 16, marginBottom: 16 }}>
              <div className="eyebrow">Your performance ranking</div>
              <p className="card-p" style={{ fontSize: 18, marginBottom: 8 }}>
                <strong>{percentile(latest.charge, avg)}th percentile</strong>
              </p>
              <p className="fine">
                Higher than {percentile(latest.charge, avg)}% of peers your age. You're in the top tier. Maintain it next week.
              </p>
            </div>
            {best === latest.charge && state.history.length > 1 && (
              <div className="pb-badge">▲ New personal best</div>
            )}
            {prev && (
              <div className="delta" style={{ color: latest.charge >= prev.charge ? chargeColor(85) : chargeColor(20) }}>
                {latest.charge >= prev.charge ? "▲" : "▼"} {Math.abs(latest.charge - prev.charge)} vs last week
              </div>
            )}
            
            {/* Quick Look: Your Six Dimensions */}
            {latest.subscores && (
              <div className="card" style={{ marginTop: 16, marginBottom: 16 }}>
                <div className="eyebrow">Your performance drivers (ranked by impact)</div>
                <p className="fine" style={{ marginBottom: 12 }}>
                  AI analysis shows your lowest-impact areas are highest-leverage for improvement. These are where you'll gain the most by Wednesday.
                </p>
                {Object.entries(latest.subscores).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([name, v]) => (
                  <div key={name} style={{ marginBottom: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span className="fine" style={{ marginTop: 0 }}>{name}</span>
                      <span className="fine" style={{ marginTop: 0, fontWeight: 600, color: chargeColor(v) }}>{v}</span>
                    </div>
                    <div style={{ height: 4, background: "var(--surface2)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${v}%`, background: chargeColor(v) }} />
                    </div>
                  </div>
                ))}
                <p className="fine" style={{ marginTop: 12, color: "var(--ink)", opacity: 0.8 }}>
                  <button className="link-btn" onClick={() => setView("today")} style={{ display: "inline", fontSize: 12 }}>
                    See full breakdown →
                  </button>
                </p>
              </div>
            )}
            
            {!commitmentChoice && topDrivers.length > 0 && (
              <div className="card commitment-card">
                <div className="eyebrow">This week's focus</div>
                <p className="card-p">One targeted adjustment creates exponential performance gains. Pick your highest-leverage move.</p>
                {topDrivers.map(([name]) => (
                  <button key={name} className="commitment-btn" onClick={() => commitToIntervention(ADJUSTMENTS[name].title)}>
                    <span className="commitment-name">{ADJUSTMENTS[name].title}</span>
                    <span className="commitment-arrow">→</span>
                  </button>
                ))}
              </div>
            )}
            {commitmentChoice && (
              <div className="commitment-confirmed">
                <div className="check-mark">✓</div>
                <p className="commitment-text">You're committing to <strong>{commitmentChoice}</strong> this week. Report back next week to keep the streak alive.</p>
              </div>
            )}
            
            
            <div className="eyebrow section-eyebrow" style={{ marginTop: 32 }}>Next steps</div>
            
            <ShareCard charge={latest.charge} best={best} />
            
            <button className="btn-primary" onClick={() => setView("today")} style={{ marginTop: 12 }}>View Your Performance Dashboard</button>
            
            {/* Donation card */}
            <div className="card" style={{ marginTop: 24, textAlign: 'left' }}>
              <div className="eyebrow">Support NEURL OS</div>
              <p className="card-p">
                If NEURL OS helps you optimize your performance and stay ahead of burnout, consider supporting its development.
              </p>
              <p className="card-p" style={{ marginBottom: 12 }}>
                Most supporters give between $5 and $30.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button className="btn-secondary" onClick={() => (window.location.href = 'https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01')}>
                  $5
                </button>
                <button className="btn-secondary" onClick={() => (window.location.href = 'https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01')}>
                  $15
                </button>
                <button className="btn-secondary" onClick={() => (window.location.href = 'https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01')}>
                  $30
                </button>
              </div>
              <button className="btn-primary" onClick={() => (window.location.href = 'https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01')}>
                Donate
              </button>
            </div>
          </div>
        )}

        {/* ---------- TODAY ---------- */}
        {view === "today" && latest && forecast && (
          <div className="fade-in">
            <div className="dash-head">
              <div className="wordmark sm">CHARGE</div>
              {state.user ? (
                <div className="streak">⚡ {streak}-week streak</div>
              ) : (
                <button className="streak streak-btn" onClick={() => openLogin("today")}>Log in to save streaks</button>
              )}
            </div>
            {state.activeCommitment && <StreakBadge commitment={state.activeCommitment} />}

            <div className="center-col" style={{ marginBottom: 20 }}>
              <ChargeCell charge={latest.charge} animate={false} size={230} />
              <div className="dash-sub">
                Read {fmtDate(latest.date)} · Top {100 - percentile(latest.charge, avg)}% of {cohort}
                {prev && (
                  <span style={{ color: latest.charge >= prev.charge ? chargeColor(85) : chargeColor(20), marginLeft: 8 }}>
                    {latest.charge >= prev.charge ? "▲" : "▼"}{Math.abs(latest.charge - prev.charge)}
                  </span>
                )}
              </div>
            </div>

            <div className="stat-row">
              <div className="stat"><div className="stat-val" style={{ color: chargeColor(best) }}>{best}%</div><div className="stat-lab">Personal peak</div></div>
              <div className="stat"><div className="stat-val">{avg}%</div><div className="stat-lab">Peer average</div></div>
              <div className="stat"><div className="stat-val">{PEAK_MIN}%+</div><div className="stat-lab">Elite zone</div></div>
            </div>

            <ChargeContext charge={latest.charge} ageBracket={bracket} />

            <div className="card">
              <div className="eyebrow">Today</div>
              <div className="today-row">
                <span className="today-tag up">Opportunity</span>
                <p className="today-p">{opportunity}</p>
              </div>
              <div className="today-row">
                <span className="today-tag down">Watch</span>
                <p className="today-p">{risk}</p>
              </div>
            </div>

            <div className="card forecast-card">
              <div className="eyebrow">Your NEURL OS Reading forecast</div>
              <div className="fc-row">
                <div className="fc-num" style={{ color: chargeColor(forecast.projected) }}>
                  {forecast.projected}%
                </div>
                <div className="fc-lab">projected<br />next week</div>
              </div>
              <p className="card-p">{forecast.narrative}</p>
              <div className="adjustment">
                <div className="adj-title">{ADJUSTMENTS[forecast.dragName].title}</div>
                <p className="adj-tip">{ADJUSTMENTS[forecast.dragName].tip}</p>
              </div>
            </div>

            <div className="card" style={{ backgroundColor: "rgba(172, 212, 255, 0.05)", borderLeft: "3px solid var(--ink)" }}>
              <div className="eyebrow" style={{ color: "var(--ink)" }}>Build your NEURL baseline, unlock predictive insights</div>
              <p className="card-p" style={{ fontSize: 14 }}>
                Your NEURL Score becomes predictive after 2–3 weeks of weekly calibrations. By week 4, our AI reveals what drives your performance: which habits move your score, when you peak, what kills your capacity. Consistent weekly data = unstoppable competitive advantage.
              </p>
            </div>

            {latest.subscores && (
              <div className="card">
                <div className="eyebrow">Your full NEURL analysis (six dimensions)</div>
                <p className="fine" style={{ marginBottom: 12 }}>
                  Each dimension 0–100. Our AI identifies which factors drive YOUR performance. Weekly calibration reveals your personal performance algorithm. Track these to optimize your NEURL Score.
                </p>
                {Object.entries(latest.subscores).sort((a, b) => a[1] - b[1]).map(([name, v]) => (
                  <div className="bar-row" key={name}>
                    <span className="bar-name">{name}</span>
                    <div className="bar-track"><div className="bar-fill" style={{ width: `${v}%`, background: chargeColor(v) }} /></div>
                    <span className="bar-val">{v}</span>
                  </div>
                ))}
                <p className="bar-note">Each dimension scored 0–100. Your lowest dimension is your highest-leverage adjustment target.</p>
              </div>
            )}

            {/* Performance Metrics Cards */}
            {latest.performanceRatio !== undefined && (
              <div className="card">
                <div className="eyebrow">Efficiency (tasks per hour)</div>
                <p className="card-p" style={{ fontSize: 20, marginBottom: 8 }}>
                  {latest.performanceRatio} <span style={{ fontSize: 14, color: "var(--muted)" }}>tasks/hour</span>
                </p>
                <p className="fine">
                  {latest.tasksCompleted} high-leverage tasks completed in {answers.totalWorkHours} hours.
                </p>
                {latest.outputQuality && (
                  <p className="fine" style={{ marginTop: 8 }}>
                    Quality: <strong>{latest.outputQuality}</strong>
                  </p>
                )}
              </div>
            )}

            {latest.cognitiveLoad !== undefined && (
              <div className="card">
                <div className="eyebrow">Decision & focus load</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, minWidth: 40, color: latest.cognitiveLoad < 50 ? chargeColor(85) : latest.cognitiveLoad < 70 ? "#FFB84D" : chargeColor(20) }}>
                    {latest.cognitiveLoad}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ height: 6, background: "var(--surface2)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${latest.cognitiveLoad}%`, background: latest.cognitiveLoad < 50 ? chargeColor(85) : latest.cognitiveLoad < 70 ? "#FFB84D" : chargeColor(20) }} />
                    </div>
                  </div>
                </div>
                <p className="fine">
                  {latest.openDecisions} open decisions · {latest.contextSwitches} context switches/day · {latest.deepWorkBlocks} deep work blocks
                </p>
                {latest.cognitiveLoad > 70 && (
                  <p className="fine" style={{ marginTop: 8, color: chargeColor(20) }}>
                    ⚠️ High cognitive load. Delegate decisions or close low-priority projects to recover focus.
                  </p>
                )}
              </div>
            )}

            {state.history.length >= 2 && (
              <div className="card">
                <div className="eyebrow">Performance history</div>
                <HistoryTrend history={state.history} avg={avg} />
              </div>
            )}

            <ShareCard charge={latest.charge} best={best} />

            <div className="card center-text">
              {dueIn > 0 ? (
                <>
                  <div className="eyebrow">Next reading</div>
                  <div className="next-big">{dueIn} day{dueIn === 1 ? "" : "s"}</div>
                  <p className="card-p">Weekly readings keep your forecast sharp. Return {dueIn === 1 ? "tomorrow" : `in ${dueIn} days`} to extend your streak.</p>
                  <button className="btn-secondary" onClick={startCheckin}>Take an early reading</button>
                </>
              ) : (
                <>
                  <div className="eyebrow">Reading due</div>
                  <p className="card-p">It's been {daysSince} day{daysSince === 1 ? "" : "s"}. Your forecast is waiting on fresh inputs.</p>
                  <button className="btn-primary wide" onClick={startCheckin}>Start this week's reading</button>
                </>
              )}
            </div>

            {/* Donation Card */}
            <div className="card" style={{ marginTop: 24, textAlign: 'left' }}>
              <div className="eyebrow">Support NEURL OS</div>
              <p className="card-p">
                If NEURL OS helps you optimize your performance and stay ahead of burnout, consider supporting its development.
              </p>
              <p className="card-p" style={{ marginBottom: 12 }}>
                Most supporters give between $5 and $30.
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 12 }}>
                <a href="https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01?prefilled_amount=500" target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textAlign: "center", textDecoration: "none" }}>$5</a>
                <a href="https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01?prefilled_amount=1500" target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textAlign: "center", textDecoration: "none" }}>$15</a>
                <a href="https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01?prefilled_amount=3000" target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ textAlign: "center", textDecoration: "none" }}>$30</a>
              </div>
              <a href="https://donate.stripe.com/00w9AT9xuaHN5bZ60Xasg01" target="_blank" rel="noopener noreferrer" className="btn-primary wide" style={{ textDecoration: "none", display: "inline-block" }}>Donate</a>
            </div>

            <div className="fine center">
              NEURL OS is a performance-awareness tool, not a medical device or healthcare service. It measures your self-reported performance capacity. For health concerns, fatigue, stress, or mental health matters, please consult with a healthcare professional. If you're struggling, talk to someone you trust or a medical professional.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- history trend ---------- */

function HistoryTrend({ history, avg = AVG_CHARGE }) {
  const w = 320, h = 92, pad = 12;
  const pts = history.slice(-8);
  const xs = (i) => pad + (i / (pts.length - 1)) * (w - pad * 2);
  const ys = (s) => h - pad - (s / 100) * (h - pad * 2);
  const path = pts.map((e, i) => `${i ? "L" : "M"}${xs(i)},${ys(e.charge)}`).join(" ");
  const first = pts[0], last = pts[pts.length - 1];
  const delta = last.charge - first.charge;
  return (
    <>
      <svg viewBox={`0 0 ${w} ${h}`} className="trend-svg" preserveAspectRatio="none">
        <line x1={pad} x2={w - pad} y1={ys(avg)} y2={ys(avg)} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 4" />
        <path d={path} fill="none" stroke="rgba(255,255,255,0.28)" strokeWidth="2" />
        {pts.map((e, i) => (
          <circle key={i} cx={xs(i)} cy={ys(e.charge)} r={i === pts.length - 1 ? 5 : 3.2} fill={chargeColor(e.charge)} />
        ))}
      </svg>
      <div className="trend-dates"><span>{fmtDate(first.date)}</span><span>{fmtDate(last.date)}</span></div>
      <p className="bar-note">
        {delta > 0
          ? `Your NEURL OS Reading is up ${delta} points since ${fmtDate(first.date)}. Your inputs are raising your baseline.`
          : delta < 0
            ? `Your NEURL OS Reading is down ${Math.abs(delta)} points since ${fmtDate(first.date)}. Your forecast shows where to recover it.`
            : `Your NEURL OS Reading is holding steady since ${fmtDate(first.date)}. Dashed line marks your age-group average (${avg}%).`}
      </p>
    </>
  );
}

/* ---------- styles ---------- */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@500;600&display=swap');

:root {
  --bg: #0A0C0F;
  --surface: #121519;
  --surface2: #191D23;
  --ink: #F2F4F7;
  --muted: #8B93A1;
  --line: rgba(255,255,255,0.08);
}
* { box-sizing: border-box; margin: 0; }
.app {
  min-height: 100vh; background: var(--bg); color: var(--ink);
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.shell { max-width: 1200px; margin: 0 auto; padding: 28px 20px 56px; }

/* Desktop-optimized spacing and widths */
@media (min-width: 769px) {
  .shell { padding: 48px 40px 80px; }
  .feature-grid { max-width: 900px; margin: 0 auto; }
  .center-col { align-items: center; }
}

/* Responsive breakpoints */
@media (max-width: 768px) {
  .shell { max-width: 430px; padding: 28px 20px 56px; }
  .hero-h { font-size: 24px; max-width: 100%; }
  .hero-p { max-width: 100%; font-size: 15.5px; }
  .feature-grid { grid-template-columns: 1fr !important; }
  .score-grid { grid-template-columns: 1fr 1fr !important; }
}

@media (max-width: 480px) {
  .shell { padding: 20px 16px 40px; }
  .hero-h { font-size: 20px; }
  .score-grid { grid-template-columns: 1fr !important; }
}

.wordmark {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 14px;
  letter-spacing: 0.34em; color: var(--ink); margin-bottom: 30px;
}
.wordmark.sm { margin-bottom: 0; font-size: 12px; }

.center-col { display: flex; flex-direction: column; align-items: center; text-align: center; }
.center-text { text-align: center; }

.hero-h {
  font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 32px;
  line-height: 1.16; letter-spacing: -0.02em; margin: 28px 0 14px;
  text-wrap: balance; max-width: 600px;
}
.hero-p { color: #B0B9C6; font-size: 16px; line-height: 1.6; max-width: 600px; margin-bottom: 30px; }
.fine { color: #A0A9B8; font-size: 12px; margin-top: 16px; line-height: 1.5; }
.fine.center { text-align: center; margin-top: 30px; }

.eyebrow {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 10.5px;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--muted); margin-bottom: 12px;
}
.section-eyebrow { margin: 6px 2px 12px; }

/* buttons */
.btn-primary {
  font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 15px;
  background: var(--ink); color: #0A0C0F; border: none; border-radius: 100px;
  padding: 16px 30px; cursor: pointer; letter-spacing: 0.01em;
  transition: transform .15s ease, opacity .15s ease;
}
.btn-primary:hover { transform: translateY(-1px); }
.btn-primary:active { transform: scale(0.98); }
.btn-primary:disabled { opacity: 0.25; cursor: default; transform: none; }
.btn-primary.wide { width: 100%; margin-top: 34px; }
.btn-secondary {
  font-family: 'Archivo', sans-serif; font-weight: 600; font-size: 13.5px;
  background: transparent; color: var(--ink); border: 1.5px solid var(--line);
  border-radius: 100px; padding: 12px 22px; cursor: pointer;
}
.btn-ghost {
  background: none; border: none; color: var(--muted); font-size: 14.5px;
  font-family: inherit; cursor: pointer; padding: 6px 8px 6px 0; white-space: nowrap;
}
.btn-ghost.link { margin-top: 16px; text-decoration: none; display: inline-block; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

/* charge cell */
.cell-wrap { position: relative; display: grid; place-items: center; }
.cell-halo { position: absolute; inset: -16%; border-radius: 50%; pointer-events: none; transition: background .6s ease; }
.cell-wrap svg { position: relative; }
.cell-center { position: absolute; display: flex; flex-direction: column; align-items: center; }
.cell-eyebrow {
  font-family: 'JetBrains Mono', monospace; font-size: 8px; font-weight: 600;
  letter-spacing: 0.16em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;
}

@media (max-width: 480px) {
  .cell-eyebrow { font-size: 7px; letter-spacing: 0.12em; }
}
.cell-num {
  font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 62px;
  letter-spacing: -0.035em; line-height: 1; font-variant-numeric: tabular-nums;
  transition: color .3s ease; display: flex; align-items: center; justify-content: center;
}
.cell-pct { font-size: 26px; font-weight: 700; opacity: 0.7; margin-left: 2px; }
.cell-state {
  font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 13px;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink); margin-top: 8px;
}

@media (max-width: 480px) {
  .cell-num { font-size: 56px; }
  .cell-pct { font-size: 24px; }
  .cell-state { font-size: 12px; margin-top: 6px; }
}

/* check-in */
.checkin-top { display: flex; align-items: center; gap: 14px; margin-bottom: 34px; }
.progress { flex: 1; height: 3px; background: var(--line); border-radius: 4px; overflow: hidden; }
.progress-fill { height: 100%; background: var(--ink); transition: width .35s cubic-bezier(.4,0,.2,1); }
.progress-num { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--muted); }

.q-title {
  font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 23px;
  line-height: 1.24; letter-spacing: -0.015em; margin-bottom: 6px;
}
.q-sub { color: var(--muted); font-size: 14px; margin-bottom: 4px; }

.slider-block { margin-top: 34px; }
.slider-val {
  font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 54px;
  letter-spacing: -0.03em; text-align: center; margin-bottom: 24px;
  font-variant-numeric: tabular-nums;
}
.slider-unit { font-size: 19px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
.slider { -webkit-appearance: none; appearance: none; width: 100%; height: 5px; border-radius: 6px; background: var(--line); outline: none; }
.slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none; width: 30px; height: 30px; border-radius: 50%;
  background: var(--ink); border: none; cursor: pointer; box-shadow: 0 3px 14px rgba(0,0,0,0.5);
}
.slider::-moz-range-thumb { width: 30px; height: 30px; border-radius: 50%; background: var(--ink); border: none; cursor: pointer; }
.slider-ends { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin-top: 12px; font-family: 'JetBrains Mono', monospace; }

.scale-row { display: flex; gap: 7px; margin-top: 28px; }
.scale-btn {
  flex: 1; background: var(--surface); border: 1.5px solid var(--line); border-radius: 14px;
  padding: 14px 4px 12px; cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 6px;
  transition: border-color .15s, transform .1s; font-family: inherit; color: var(--ink);
}
.scale-btn:active { transform: scale(0.96); }
.scale-btn.on { border-color: var(--ink); background: var(--ink); color: #0A0C0F; }
.scale-n { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 17px; }
.scale-lab { font-size: 9.5px; opacity: 0.75; text-align: center; line-height: 1.2; }

.chip-col { display: flex; flex-direction: column; gap: 10px; margin-top: 26px; }
.chip {
  background: var(--surface); border: 1.5px solid var(--line); border-radius: 14px;
  padding: 16px 18px; font-size: 15px; font-family: inherit; font-weight: 500;
  color: var(--ink); text-align: left; cursor: pointer;
  transition: border-color .15s, background .15s, transform .1s;
}
.chip:active { transform: scale(0.985); }
.chip.on { border-color: var(--ink); background: var(--ink); color: #0A0C0F; }
.chip.muted { color: var(--muted); }
.chip.muted.on { color: #0A0C0F; }

/* reveal */
.state-desc { color: var(--muted); font-size: 15px; line-height: 1.55; max-width: 310px; margin: 20px 0 8px; }
.ctx-line { font-size: 13.5px; color: var(--ink); margin-bottom: 12px; }
.pb-badge {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 11px; letter-spacing: 0.1em;
  color: hsl(172, 80%, 60%); background: hsla(172, 80%, 55%, 0.1);
  border: 1px solid hsla(172, 80%, 55%, 0.3);
  border-radius: 100px; padding: 6px 14px; margin-bottom: 12px;
}
.delta { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 14px; margin-bottom: 26px; }

/* dashboard */
.dash-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
.streak {
  font-family: 'JetBrains Mono', monospace; font-weight: 600; font-size: 11px; letter-spacing: 0.06em;
  background: var(--surface); border: 1px solid var(--line); border-radius: 100px; padding: 7px 14px;
}
.dash-sub { color: var(--muted); font-size: 13px; margin-top: 14px; }

.card {
  background: var(--surface); border-radius: 20px; padding: 20px;
  margin-bottom: 14px; border: 1px solid var(--line);
}
.card-p { color: var(--muted); font-size: 14px; line-height: 1.6; }
.stat-row { display: flex; gap: 10px; margin-bottom: 14px; }
.stat {
  flex: 1; background: var(--surface); border: 1px solid var(--line);
  border-radius: 16px; padding: 14px 8px; text-align: center;
}
.stat-val { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 21px; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat-lab { color: var(--muted); font-size: 10.5px; margin-top: 5px; font-family: 'JetBrains Mono', monospace; letter-spacing: 0.04em; }

/* context gauge + legend */
.ctx-p { color: var(--muted); font-size: 13.5px; line-height: 1.6; margin-bottom: 24px; }
.ctx-p strong { color: var(--ink); font-weight: 600; }
.gauge { position: relative; height: 72px; margin: 0 4px 16px; }
.gauge-track {
  position: absolute; top: 33px; left: 0; right: 0; height: 7px; border-radius: 8px;
  background: linear-gradient(90deg, hsl(8,85%,52%) 0%, hsl(28,85%,52%) 30%, hsl(45,85%,52%) 50%, hsl(110,70%,48%) 72%, hsl(172,85%,52%) 100%);
  opacity: 0.9;
}
.gauge-marker {
  position: absolute; top: 29px; width: 15px; height: 15px; border-radius: 50%;
  transform: translateX(-50%); border: 2.5px solid var(--bg);
  box-shadow: 0 0 10px rgba(0,0,0,0.6);
}
.gauge-marker.avg { background: #C3CAD6; width: 11px; height: 11px; top: 31px; }
.gauge-tag {
  position: absolute; transform: translateX(-50%);
  font-family: 'JetBrains Mono', monospace; font-size: 10.5px; font-weight: 700;
  white-space: nowrap; background: var(--surface); padding: 2px 6px; border-radius: 6px;
}
.gauge-tag.you-tag { top: 2px; }
.gauge-tag.avg-tag { bottom: 0; color: #C3CAD6; }
.legend { display: flex; flex-direction: column; gap: 2px; }
.legend-row {
  display: grid; grid-template-columns: 12px 76px 46px 1fr; gap: 8px; align-items: baseline;
  padding: 8px 8px; border-radius: 12px; font-size: 12px;
}
.legend-row.current { background: rgba(255,255,255,0.05); }
.legend-dot { width: 8px; height: 8px; border-radius: 50%; align-self: center; box-shadow: 0 0 6px currentColor; }
.legend-name { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 12px; }
.legend-range { color: var(--muted); font-family: 'JetBrains Mono', monospace; font-size: 10.5px; }
.legend-desc { color: var(--muted); line-height: 1.45; }

/* today card */
.today-row { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
.today-row:last-child { margin-bottom: 0; }
.today-tag {
  font-family: 'JetBrains Mono', monospace; font-size: 9.5px; font-weight: 600; letter-spacing: 0.1em;
  text-transform: uppercase; border-radius: 6px; padding: 4px 8px; white-space: nowrap; margin-top: 2px;
}
.today-tag.up { color: hsl(172,80%,60%); background: hsla(172,80%,55%,0.1); }
.today-tag.down { color: hsl(38,90%,60%); background: hsla(38,90%,55%,0.1); }
.today-p { color: var(--ink); font-size: 13.5px; line-height: 1.55; }

/* dimensions */
.dim-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
.dim-card {
  background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
  padding: 16px 14px; display: flex; flex-direction: column; align-items: center; text-align: center;
}
.mini-wrap { position: relative; display: grid; place-items: center; }
.mini-num {
  position: absolute; font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 17px;
  font-variant-numeric: tabular-nums;
}
.dim-name { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 13.5px; margin-top: 6px; }
.dim-sub { color: var(--muted); font-size: 10.5px; line-height: 1.4; margin-top: 3px; }

/* forecast */
.forecast-card { border-color: rgba(255,255,255,0.14); background: var(--surface2); }
.fc-row { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.fc-num { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 44px; letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
.fc-lab { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; line-height: 1.5; }
.adjustment { border-left: 2px solid var(--ink); padding-left: 14px; margin-top: 16px; }
.adj-title { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 14.5px; margin-bottom: 5px; }
.adj-tip { color: var(--muted); font-size: 13.5px; line-height: 1.55; }

/* inputs bars */
.bar-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.bar-name { width: 78px; font-size: 13px; font-weight: 500; }
.bar-track { flex: 1; height: 7px; background: rgba(255,255,255,0.06); border-radius: 8px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 8px; transition: width .8s cubic-bezier(.4,0,.2,1); box-shadow: 0 0 8px currentColor; }
.bar-val { width: 28px; text-align: right; font-family: 'JetBrains Mono', monospace; font-size: 11.5px; color: var(--muted); }
.bar-note { color: var(--muted); font-size: 12px; line-height: 1.5; margin-top: 12px; }

/* trend */
.trend-svg { width: 100%; height: 92px; }
.trend-dates { display: flex; justify-content: space-between; color: var(--muted); font-size: 10.5px; font-family: 'JetBrains Mono', monospace; margin-top: 6px; }

/* share */
.share-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 14px; }
.share-btn { text-decoration: none; display: inline-block; padding: 12px 16px; font-size: 13px; margin-top: 0; flex: 1 1 calc(50% - 5px); min-width: 140px; }
@media (min-width: 500px) { .share-btn { flex: 0 1 auto; } }

.next-big { font-family: 'Archivo', sans-serif; font-weight: 800; font-size: 40px; letter-spacing: -0.02em; margin-bottom: 8px; }

/* pulsing (welcome screen) */
.cell-wrap.pulsing .cell-halo { animation: haloPulse 2.6s ease-in-out infinite; }
.cell-wrap.pulsing .cell-svg { animation: cellBreathe 2.6s ease-in-out infinite; }
.cell-wrap.pulsing .cell-num { animation: numGlow 2.6s ease-in-out infinite; }
@keyframes haloPulse {
  0%, 100% { opacity: 0.55; transform: scale(0.96); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes cellBreathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.022); }
}
@keyframes numGlow {
  0%, 100% { filter: drop-shadow(0 0 0px transparent); }
  50% { filter: drop-shadow(0 0 14px hsla(150, 90%, 55%, 0.5)); }
}
@media (prefers-reduced-motion: reduce) {
  .cell-wrap.pulsing .cell-halo, .cell-wrap.pulsing .cell-svg, .cell-wrap.pulsing .cell-num { animation: none; }
}

/* commitment */
.streak-badge {
  display: inline-flex; align-items: center; gap: 6px; margin: 16px 0;
  padding: 8px 14px; background: rgba(255,215,0,0.08); border-radius: 100px;
  border: 1px solid rgba(255,215,0,0.2);
}
.streak-text { font-family: 'Archivo', sans-serif; font-weight: 700; font-size: 13px; color: var(--ink); }
.commitment-card { text-align: center; border-color: rgba(255,255,255,0.14); background: var(--surface2); }
.commitment-btn {
  display: flex; align-items: center; justify-content: space-between;
  width: 100%; background: var(--surface); border: 1.5px solid var(--line); border-radius: 14px;
  padding: 14px 16px; margin-bottom: 10px; cursor: pointer; font-family: inherit; color: var(--ink);
  transition: border-color .15s, background .15s;
}
.commitment-btn:active { transform: scale(0.985); }
.commitment-btn:hover { border-color: rgba(255,255,255,0.24); }
.commitment-name { text-align: left; font-size: 14px; font-weight: 500; }
.commitment-arrow { color: var(--muted); font-size: 18px; }
.commitment-confirmed {
  text-align: center; margin: 20px 0; padding: 20px; background: rgba(172, 200, 162, 0.08);
  border: 1px solid rgba(172, 200, 162, 0.2); border-radius: 16px;
}
.check-mark { font-size: 40px; margin-bottom: 8px; }
.commitment-text { color: var(--muted); font-size: 14px; line-height: 1.6; }
.commitment-text strong { color: var(--ink); }

/* login */
.login-btn { margin-top: 14px; }
.signed-in { color: var(--muted); font-size: 13px; margin-top: 16px; }
.link-btn { background: none; border: none; color: var(--ink); font-size: 13px; font-family: inherit; cursor: pointer; text-decoration: underline; padding: 0; }
.login-block { margin-top: 26px; }
.login-input {
  width: 100%; background: var(--surface); border: 1.5px solid var(--line); border-radius: 14px;
  color: var(--ink); font-family: inherit; font-size: 15px; padding: 15px 18px; outline: none;
  margin-bottom: 10px;
}
.login-input:focus { border-color: rgba(255,255,255,0.3); }
.streak-btn { cursor: pointer; color: var(--ink); font-family: 'JetBrains Mono', monospace; }

/* motion */
.fade-in { animation: fade .45s ease both; }
.slide-l { animation: slideL .3s cubic-bezier(.4,0,.2,1) both; }
.slide-r { animation: slideR .3s cubic-bezier(.4,0,.2,1) both; }
@keyframes fade { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes slideL { from { opacity: 0; transform: translateX(26px); } to { opacity: 1; transform: none; } }
@keyframes slideR { from { opacity: 0; transform: translateX(-26px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .fade-in, .slide-l, .slide-r { animation: none; }
  .bar-fill, .progress-fill { transition: none; }
}
.loading-dot {
  width: 10px; height: 10px; border-radius: 50%; background: var(--muted);
  margin: 40vh auto 0; animation: pulse 1s ease infinite alternate;
}
@keyframes pulse { from { opacity: 0.3; } to { opacity: 1; } }

@media (min-width: 700px) {
  .shell { max-width: 480px; padding-top: 48px; }
  .hero-h { font-size: 34px; }
}
`;
