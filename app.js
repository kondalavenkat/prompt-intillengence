'use strict';

/* =====================================================================
   PromptForge — agentic prompt support system (100% client-side)
   Pipeline: Intake → Intent → Context → Structure → Critic
   ===================================================================== */

/* ---------------- 0. Utilities ---------------- */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const dedupe = (arr) => Array.from(new Set(arr));

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------------- 1. Sample data ---------------- */

const SAMPLES = {
  support: {
    mode: 'conversation',
    label: 'Support chat',
    text: `Customer (Priya Nair): Hi, I've been charged twice for my March subscription to CloudFlow Pro. My card ending 4471 shows two debits of $49 on March 3rd.
Agent (Rohan): I'm sorry about that, Priya. I can see the duplicate charge on account CF-88213 in the billing system.
Customer (Priya Nair): This is the second time it has happened. I need the refund processed today, and I want to make sure auto-renew is fixed before April 2nd.
Agent (Rohan): I've filed ticket BILL-2211 and issued a refund of $49 to the card ending 4471. It should arrive within 3-5 business days. I've also flagged the billing sync issue for our payments team.
Customer (Priya Nair): Can you confirm by email once the refund clears? Also, how do I export my invoices for the last 12 months?
Agent (Rohan): Yes, you'll get a confirmation at priya.nair@example.com. For invoices, go to Settings, then Billing, then Export, and choose CSV.`,
  },
  meeting: {
    mode: 'recording',
    label: 'Meeting transcript',
    text: `Meeting: Q3 Launch Planning, July 9
Attendees: Dana (PM), Marcus (Engineering), Lila (Design), Tom (Marketing)

Dana: We need to finalize the launch plan for the mobile onboarding revamp. Target date is September 15.
Marcus: Engineering needs three more weeks for the SSO integration. The API gateway migration is blocking us, and we can only test on staging until infra approves the production deploy.
Lila: Design will deliver the final Figma mocks by Friday. We must keep the signup flow under four steps, that was the main drop-off point in the last cohort analysis.
Tom: Marketing wants the launch email drafted two weeks before release. Budget for paid acquisition is capped at $12,000 for Q3.
Dana: Action items: Marcus to resolve the gateway blocker by July 18, Lila to share the mocks on Friday, Tom to circulate the email draft by September 1. Let's schedule a go/no-go review on September 8.`,
  },
  idea: {
    mode: 'idea',
    label: 'App idea',
    text: `Rough idea: an app for freelance designers to track client revisions.

- clients keep asking for "one small change" and scope creep kills margins
- want to log every revision request and tie it to the original quote
- auto-flag when a project exceeds the included revisions
- maybe a client-facing portal where clients submit requests instead of emailing
- should generate a polite "this is outside scope" message with a price quote for the extra work
- integrate with Stripe for add-on payments
- simple dashboard: active projects, revisions used vs included, revenue lost to scope creep`,
  },
};

/* ---------------- 2. NLP primitives ---------------- */

const STOPWORDS = new Set(
  ('a,an,the,and,or,but,if,then,else,for,to,of,in,on,at,by,with,from,as,is,are,was,were,be,been,being,' +
    'it,its,this,that,these,those,i,you,he,she,we,they,me,him,her,us,them,my,your,his,our,their,mine,yours,ours,' +
    'am,do,does,did,have,has,had,having,not,no,yes,so,too,very,can,could,should,would,will,shall,may,might,must,' +
    'just,also,than,there,here,when,where,which,who,whom,what,how,why,about,into,over,under,again,once,any,all,' +
    'both,each,few,more,most,other,some,such,own,same,only,out,up,down,off,because,until,while,during,before,' +
    'after,above,below,between,through,get,got,go,going,really,like,said,say,says,hi,hello,hey,thanks,thank,' +
    'please,ok,okay,sure,yeah,yep,nope,well,now,one,two,per,via,etc,let,lets,im,ive,id,youre,youll,weve,dont,' +
    'january,february,march,april,may,june,july,august,september,october,november,december,' +
    'monday,tuesday,wednesday,thursday,friday,saturday,sunday')
    .split(',')
);

// Words that look like capitalized names but aren't people.
const NON_PERSON_WORDS = new Set(
  ('Meeting,Attendees,Date,Time,Subject,Note,Notes,Action,Items,Transcript,Recording,Rough,Idea,Settings,Billing,' +
    'Export,Engineering,Design,Marketing,Sales,Support,Product,Infra,Finance,Customer,Agent,User,Caller,Client,' +
    'Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday,January,February,March,April,May,June,July,August,' +
    'September,October,November,December,Hi,Hello,Hey,Yes,No,OK,The,This,That,Summary,Agenda,' +
    'Click,Select,Choose,Press,Enter,Go,Make,Let')
    .split(',')
);

// A multi-word label counts as a non-person only if every word is a known non-person word
// (so "Rough idea" is rejected but "Priya Nair" survives).
const isNonPerson = (label) =>
  label.split(/\s+/).every((w) => NON_PERSON_WORDS.has(w) || NON_PERSON_WORDS.has(capitalize(w)));

const SYSTEM_WORDS = [
  'billing system', 'api gateway', 'knowledge base', 'cloudflow pro', 'figma', 'stripe', 'salesforce',
  'tableau', 'jira', 'slack', 'hubspot', 'zendesk', 'shopify', 'wordpress', 'sap', 'oracle', 'postgres',
  'mysql', 'mongodb', 'redis', 'kafka', 'sso', 'api', 'apis', 'csv', 'json', 'sql', 'crm', 'erp',
  'dashboard', 'portal', 'database', 'staging', 'production', 'backend', 'frontend', 'mobile app',
  'website', 'web app', 'app', 'gateway', 'server', 'email', 'gmail', 'outlook', 'excel', 'sheets',
  'calendar', 'ticket system', 'analytics', 'data warehouse', 's3', 'aws', 'azure', 'gcp',
];

const ACTION_VERBS = [
  'resolve', 'process', 'confirm', 'export', 'send', 'create', 'build', 'design', 'implement', 'fix',
  'deploy', 'schedule', 'draft', 'finalize', 'deliver', 'share', 'circulate', 'review', 'approve', 'test',
  'migrate', 'integrate', 'generate', 'log', 'track', 'flag', 'automate', 'refund', 'cancel', 'update',
  'document', 'analyze', 'summarize', 'extract', 'plan', 'prioritize', 'assign', 'notify', 'investigate',
  'diagnose', 'reduce', 'increase', 'improve', 'launch', 'prepare', 'organize', 'coordinate', 'validate',
  'verify', 'monitor', 'optimize', 'refactor', 'write', 'develop', 'configure', 'handle', 'follow up',
  'set up', 'file', 'issue', 'check', 'submit', 'collect', 'gather', 'compare', 'estimate', 'outline',
];

function splitSentences(text) {
  const parts = text.match(/[^.!?\n]+[.!?]*/g) || [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 1);
}

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9'-]*/g) || []);
}

function topKeywords(text, n) {
  const freq = new Map();
  for (const tok of tokenize(text)) {
    if (tok.length < 4 || STOPWORDS.has(tok) || /^\d+$/.test(tok)) continue;
    freq.set(tok, (freq.get(tok) || 0) + 1);
  }
  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

/* ---------------- 3. Agent 1 — Intake ---------------- */

const SPEAKER_RE = /^([A-Z][A-Za-z' .-]{0,28}?)(?:\s*\(([^)]+)\))?:\s+/;
const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

function runIntake(raw, declaredMode) {
  const text = raw.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const sentences = splitSentences(text);

  // --- speaker turns & people ---
  const speakers = new Map(); // display name -> turn count
  const roles = new Map(); // person -> role
  let speakerLines = 0;
  for (const line of lines) {
    const m = line.match(SPEAKER_RE);
    if (!m) continue;
    const label = m[1].trim();
    const paren = m[2] ? m[2].trim() : null;
    if (isNonPerson(label) && !paren) continue;
    speakerLines++;
    if (paren) {
      // "Customer (Priya Nair)" -> person is Priya Nair, role is Customer
      if (/^[A-Z][a-z]+/.test(paren) && paren.length <= 24 && !/^(PM|QA|Dev|Eng|Design|Marketing|Sales|Support|Engineering|Product)$/i.test(paren)) {
        speakers.set(paren, (speakers.get(paren) || 0) + 1);
        roles.set(paren, label);
      } else {
        speakers.set(label, (speakers.get(label) || 0) + 1);
        roles.set(label, paren);
      }
    } else if (!isNonPerson(label)) {
      speakers.set(label, (speakers.get(label) || 0) + 1);
    }
  }

  // "Attendees: Dana (PM), Marcus (Engineering)" style rosters
  const attendeesMatch = text.match(/Attendees?:\s*(.+)/i);
  if (attendeesMatch) {
    for (const chunk of attendeesMatch[1].split(/[,;]/)) {
      const cm = chunk.trim().match(/^([A-Z][a-z]+)(?:\s*\(([^)]+)\))?/);
      if (cm && !isNonPerson(cm[1])) {
        speakers.set(cm[1], speakers.get(cm[1]) || 1);
        if (cm[2]) roles.set(cm[1], cm[2]);
      }
    }
  }

  // "Name to <verb>" action-item assignments ("Marcus to resolve…")
  const people = new Set(speakers.keys());
  const assignRe = /\b([A-Z][a-z]+)\s+to\s+(?:[a-z]+)/g;
  let am;
  while ((am = assignRe.exec(text)) !== null) {
    if (!isNonPerson(am[1]) && !STOPWORDS.has(am[1].toLowerCase())) people.add(am[1]);
  }
  // "I'm <Name>" self introductions
  const introRe = /\bI'?m\s+([A-Z][a-z]+)\b/g;
  while ((am = introRe.exec(text)) !== null) {
    if (!isNonPerson(am[1])) people.add(am[1]);
  }

  // --- systems ---
  const lower = text.toLowerCase();
  const systems = [];
  for (const sys of SYSTEM_WORDS.slice().sort((a, b) => b.length - a.length)) {
    if (new RegExp('\\b' + escapeRe(sys) + '\\b', 'i').test(text)) systems.push(sys);
  }
  // ALL-CAPS acronyms (SSO, API, CSV…) not already covered; skip ID prefixes like "CF-88213"
  const acronyms = text.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) || [];
  for (const ac of acronyms) {
    if (['AM', 'PM', 'OK', 'HI', 'ID', 'Q1', 'Q2', 'Q3', 'Q4'].includes(ac)) continue;
    if (new RegExp('\\b' + ac + '-\\d').test(text)) continue;
    if (!systems.some((s) => s.toUpperCase() === ac)) systems.push(ac);
  }

  // --- numbers, dates, money ---
  const numMatches = text.match(
    /\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d+(?:\.\d+)?\s?(?:%|percent|business days|weeks?|months?|days?|hours?|steps?|k)\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\bQ[1-4]\b|\b\d{4}-\d{2}-\d{2}\b/gi
  ) || [];

  // --- actions (imperatives, infinitives, polite requests, completed actions) ---
  const actions = [];
  const verbInf = ACTION_VERBS.map((v) => escapeRe(v) + '(?:s|ed|ing)?').join('|');
  // cut a capture where the next "Name to …" assignment begins
  const cutAtNextAssign = (phrase) => phrase.replace(/,?\s+[A-Z][a-z]+\s+to\s+[a-z]+.*$/, '').trim();
  const pushAction = (verb, rest) => {
    const phrase = cutAtNextAssign((verb + ' ' + rest).replace(/\s+/g, ' '));
    if (phrase.length > 3) actions.push(capitalize(shorten(phrase, 80)));
  };
  const impRe = new RegExp('^(?:please\\s+)?(' + verbInf + ')\\b\\s*([^.!?\\n]{0,70})', 'i');
  const toRe = new RegExp('\\bto\\s+(' + verbInf + ')\\b\\s*([^.!?\\n]{2,70})', 'gi');
  const politeRe = new RegExp('\\b(?:can you|could you|how do i|how to)\\s+(' + verbInf + ')\\b\\s*([^.!?\\n]{2,70})', 'gi');
  const doneRe = new RegExp("\\b(?:i|we)'?ve\\s+(" + verbInf + ')\\b\\s*([^.!?\\n]{2,70})', 'gi');
  for (const s of sentences) {
    const im = s.match(impRe);
    if (im) pushAction(im[1], im[2]);
  }
  let tm;
  for (const re of [toRe, politeRe, doneRe]) {
    while ((tm = re.exec(text)) !== null) pushAction(tm[1], tm[2]);
  }
  const cleanActions = dedupe(actions).slice(0, 6);

  // --- constraints / goals / questions ---
  const CONSTRAINT_RE = /\b(must|only|no more than|at most|up to|within|capped|budget|under\s+\$?\d|before\s+[A-Z]?[a-z]+\s+\d|by\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|deadline|cannot|can't|never|required|has to|maximum|limit|instead of|exceeds?)\b/i;
  const GOAL_RE = /\b(wants? to|needs? to|need to|trying to|goal|aim(?:ing)? to|hopes? to|would like|looking to|plan(?:ning)? to|so that|in order to|we'd like|i'd like|want to)\b/i;
  const stripLabel = (s) => s.replace(/^[A-Z][A-Za-z' .-]{0,28}?(?:\s*\([^)]+\))?:\s+/, '');
  const constraints = [];
  const goals = [];
  const questions = [];
  for (const s of sentences) {
    const clean = shorten(stripLabel(s.replace(/\s+/g, ' ')), 170);
    if (CONSTRAINT_RE.test(s)) constraints.push(clean);
    if (GOAL_RE.test(s)) goals.push(clean);
    if (s.trim().endsWith('?')) questions.push(clean);
  }

  // --- input type detection ---
  const bulletLines = lines.filter((l) => BULLET_RE.test(l)).length;
  const bulletRatio = lines.length ? bulletLines / lines.length : 0;
  let type;
  if (speakers.size >= 2 && speakerLines >= 2) {
    type = /meeting|attendees|transcript|recording/i.test(text) ? 'recording' : 'conversation';
  } else if (bulletRatio >= 0.35 && bulletLines >= 2) {
    type = 'idea';
  } else {
    type = declaredMode;
  }

  // drop systems that are just substrings of a longer detected system ("gateway" ⊂ "api gateway")
  const dedupedSystems = dedupe(systems).filter(
    (s, i, arr) => !arr.some((other, j) => j !== i && other.length > s.length && other.toLowerCase().includes(s.toLowerCase()))
  );
  // keep people names out of the keyword list
  const nameTokens = new Set(
    Array.from(people).flatMap((p) => p.toLowerCase().split(/\s+/))
  );
  const keywords = topKeywords(text, 12).filter((k) => !nameTokens.has(k)).slice(0, 8);

  return {
    text,
    lines,
    sentences,
    type,
    declaredMode,
    bulletRatio,
    speakers: Array.from(speakers.keys()),
    roles,
    entities: {
      people: Array.from(people).slice(0, 8),
      systems: dedupedSystems.slice(0, 8),
      numbers: dedupe(numMatches.map((m) => m.trim())).slice(0, 10),
    },
    actions: cleanActions,
    constraints: dedupe(constraints).slice(0, 6),
    goals: dedupe(goals).slice(0, 6),
    questions: dedupe(questions).slice(0, 5),
    keywords,
  };
}

/* ---------------- 4. Agent 2 — Intent ---------------- */

const INTENT_PATTERNS = {
  'task-execution': [
    'create', 'build', 'generate', 'write', 'make', 'update', 'send', 'schedule', 'set up', 'implement',
    'add', 'remove', 'fix', 'deploy', 'rename', 'convert', 'export', 'import', 'draft', 'compose',
    'produce', 'automate', 'finalize', 'deliver', 'resolve', 'circulate', 'submit', 'configure',
  ],
  'information-seeking': [
    'what', 'how', 'why', 'when', 'where', 'explain', 'tell me', 'show me', 'meaning', 'difference',
    'status', 'details', 'information', 'find out', 'understand', 'clarify', 'confirm',
  ],
  'creative-generation': [
    'idea', 'brainstorm', 'design', 'imagine', 'story', 'creative', 'concept', 'slogan', 'name for',
    'logo', 'theme', 'vision', 'invent', 'dream up', 'app for', 'scope creep',
  ],
  'analysis/reasoning': [
    'analyze', 'analysis', 'compare', 'evaluate', 'assess', 'root cause', 'trend', 'correlation',
    'pros and cons', 'trade-off', 'trade off', 'review', 'diagnose', 'investigate', 'breakdown', 'metrics', 'cohort',
  ],
  'code-generation': [
    'code', 'function', 'script', 'api', 'bug', 'error', 'python', 'javascript', 'typescript', 'sql',
    'query', 'regex', 'compile', 'debug', 'endpoint', 'class', 'variable', 'json', 'html', 'css', 'sdk',
  ],
  'support-resolution': [
    'refund', 'billing', 'charged', 'subscription', 'cancel', 'account', 'login', 'password', 'issue',
    'problem', 'broken', 'not working', 'frustrated', 'complaint', 'ticket', 'order', 'delivery',
    'payment', 'charged twice', 'duplicate', 'invoice', 'help',
  ],
  'data-extraction': [
    'extract', 'list all', 'parse', 'pull out', 'names', 'dates', 'amounts', 'emails', 'phone',
    'table', 'csv', 'entities', 'action items', 'minutes', 'fields', 'export',
  ],
  'planning': [
    'plan', 'roadmap', 'schedule', 'timeline', 'milestone', 'sprint', 'deadline', 'prioritize',
    'agenda', 'next steps', 'action items', 'assign', 'owner', 'follow up', 'quarter', 'launch',
    'target date', 'go/no-go', 'launch plan', 'kickoff', 'deliverable', 'release', 'q1', 'q2', 'q3', 'q4',
  ],
};

const INTENT_LABELS = {
  'task-execution': 'Task execution',
  'information-seeking': 'Information seeking',
  'creative-generation': 'Creative generation',
  'analysis/reasoning': 'Analysis & reasoning',
  'code-generation': 'Code generation',
  'support-resolution': 'Support resolution',
  'data-extraction': 'Data extraction',
  'planning': 'Planning',
};

function classifyIntents(intake) {
  const text = intake.text.toLowerCase();
  const raw = {};
  for (const [name, patterns] of Object.entries(INTENT_PATTERNS)) {
    let s = 0;
    for (const p of patterns) {
      const re = p.includes(' ')
        ? new RegExp(escapeRe(p), 'g')
        : new RegExp('\\b' + escapeRe(p), 'g');
      const hits = text.match(re);
      if (hits) s += (p.includes(' ') ? 3 : 1) * hits.length;
    }
    raw[name] = s;
  }

  // contextual boosts from intake signals
  if (intake.speakers.length >= 2) raw['support-resolution'] += 2;
  if (/refund|charged twice|duplicate charge|billing/i.test(text)) raw['support-resolution'] += 4;
  raw['information-seeking'] += Math.min(intake.questions.length, 3);
  if (intake.bulletRatio > 0.35) {
    raw['planning'] += 2;
    raw['creative-generation'] += 1;
  }
  if (/action items|next steps|target date|go\/no-go|launch plan/i.test(text)) raw['planning'] += 4;
  if (/rough idea|brainstorm|what if|app for|scope creep/i.test(text)) raw['creative-generation'] += 3;
  if (intake.type === 'idea') raw['creative-generation'] += 2;
  if (intake.type === 'recording') raw['planning'] += 1;

  // soften with a <1 exponent so percentages stay readable
  const softened = Object.entries(raw).map(([name, s]) => [name, Math.pow(Math.max(s, 0), 0.75)]);
  const total = softened.reduce((acc, [, s]) => acc + s, 0) || 1;
  return softened
    .map(([name, s]) => ({ name, label: INTENT_LABELS[name], pct: Math.round((100 * s) / total) }))
    .sort((a, b) => b.pct - a.pct);
}

/* ---------------- 5. Agent 3 — Context levels ---------------- */

const LEVELS = {
  1: { name: 'Minimal', desc: 'Core instruction only — best for simple, direct tasks.' },
  2: { name: 'Session', desc: 'Instruction + conversation/session background.' },
  3: { name: 'Domain', desc: 'Adds domain framing, audience, tone and constraints.' },
  4: { name: 'Agent / System', desc: 'Full system-prompt spec: persona, capabilities, guardrails, tools, output schema.' },
};

const DOMAINS = [
  { name: 'product launch & project management', words: ['launch', 'onboarding', 'roadmap', 'sprint', 'milestone', 'stakeholder', 'deliverable', 'release', 'go/no-go', 'marketing', 'cohort'] },
  { name: 'SaaS billing & subscriptions', words: ['billing', 'invoice', 'subscription', 'refund', 'charge', 'payment', 'renew', 'auto-renew'] },
  { name: 'customer support operations', words: ['ticket', 'customer', 'agent', 'queue', 'escalat', 'complaint', 'support'] },
  { name: 'freelance & client services', words: ['client', 'freelance', 'quote', 'scope', 'revision', 'margins'] },
  { name: 'software engineering', words: ['api', 'deploy', 'bug', 'code', 'database', 'server', 'integration', 'staging', 'migration', 'sso'] },
  { name: 'design & creative work', words: ['design', 'figma', 'mock', 'brand', 'logo', 'creative', 'visual'] },
  { name: 'data & analytics', words: ['dashboard', 'metric', 'report', 'data', 'analytics', 'tableau', 'sql'] },
];

const TONES = {
  'task-execution': 'direct, precise, completion-oriented',
  'information-seeking': 'clear, explanatory, patient',
  'creative-generation': 'energetic, imaginative, on-brief',
  'analysis/reasoning': 'analytical, evidence-led, structured',
  'code-generation': 'technical, precise, pragmatic',
  'support-resolution': 'empathetic, professional, solution-oriented',
  'data-extraction': 'exact, literal, exhaustive',
  'planning': 'crisp, action-oriented, accountable',
};

const PERSONAS = {
  'task-execution': 'a senior operations specialist who executes tasks precisely and confirms completion',
  'information-seeking': 'a domain-expert researcher who answers with evidence and states assumptions',
  'creative-generation': 'an award-winning creative director who generates original, on-brief concepts',
  'analysis/reasoning': 'a principal analyst who reasons rigorously and quantifies trade-offs',
  'code-generation': 'a staff software engineer who writes production-grade, well-tested code',
  'support-resolution': 'a senior customer support specialist who resolves issues empathetically and efficiently',
  'data-extraction': 'a meticulous data-extraction engine that never invents values',
  'planning': 'a chief of staff who turns ambiguity into sequenced, owned, dated plans',
};

const JSON_SCHEMAS = {
  'support-resolution': { issue: 'string', root_cause: 'string | null', resolution_steps: ['string'], customer_sentiment: 'positive | neutral | negative', follow_ups: ['string'], resolved: 'boolean' },
  'planning': { objective: 'string', milestones: [{ name: 'string', owner: 'string', due: 'string' }], risks: ['string'], next_actions: [{ action: 'string', owner: 'string' }] },
  'creative-generation': { concept: 'string', tagline: 'string', key_features: ['string'], differentiators: ['string'], open_questions: ['string'] },
  'task-execution': { result: 'string', steps_taken: ['string'], artifacts: ['string'], verification: 'string' },
  'information-seeking': { answer: 'string', evidence: ['string'], assumptions: ['string'], confidence: 'low | medium | high' },
  'analysis/reasoning': { finding: 'string', reasoning: ['string'], trade_offs: ['string'], recommendation: 'string' },
  'code-generation': { language: 'string', code: 'string', explanation: 'string', tests: ['string'] },
  'data-extraction': { entities: [{ type: 'string', value: 'string' }], fields: 'object', missing: ['string'] },
};

function guessDomain(intake) {
  const text = intake.text.toLowerCase();
  let best = { name: 'general productivity', score: 0 };
  for (const d of DOMAINS) {
    let score = 0;
    for (const w of d.words) {
      const hits = text.match(new RegExp(escapeRe(w), 'g'));
      if (hits) score += hits.length;
    }
    if (score > best.score) best = { name: d.name, score };
  }
  return best.name;
}

function guessAudience(intake, primaryIntent) {
  const roleVals = Array.from(intake.roles.values()).join(' ').toLowerCase();
  if (/customer|agent|caller|support/.test(roleVals)) return 'a customer and the support agent handling their case';
  if (intake.roles.size >= 2) return 'an internal cross-functional team (' + Array.from(intake.roles.values()).slice(0, 4).join(', ') + ')';
  if (primaryIntent === 'creative-generation') return 'product builders and design stakeholders';
  if (primaryIntent === 'support-resolution') return 'a customer awaiting resolution';
  return 'a general professional audience';
}

function synthesizeInstruction(intake, primaryIntent) {
  const clean = (s) =>
    s.replace(/^[A-Z][A-Za-z' .-]{0,28}?:\s+/, '') // leading speaker label
      .replace(BULLET_RE, '') // leading bullet marker
      .trim();
  let core = null;
  let quoted = false;
  if (intake.goals.length) core = clean(intake.goals[0]);
  else if (intake.actions.length) core = intake.actions[0];
  else if (intake.questions.length) {
    core = clean(intake.questions[0]);
    quoted = true;
  }
  if (!core) core = 'Complete the task described in the source input';
  if (!quoted) {
    // "We need to finalize X" / "want to log X" -> imperative "finalize X" / "log X"
    const inf = core.match(/^(?:(?:we|i)\s+)?(?:want|needs?|would like|'d like)\s+to\s+(.*)$/i);
    if (inf) core = inf[1];
    else if (/^(?:we|i)\b/i.test(core)) quoted = true; // first-person request reads better quoted
  }
  core = core.replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim();
  const prefix = {
    'support-resolution': 'Resolve this support case: ',
    'planning': 'Produce an actionable plan: ',
    'creative-generation': 'Develop this concept: ',
    'analysis/reasoning': 'Analyze the following: ',
    'code-generation': 'Implement the following: ',
    'data-extraction': 'Extract structured data from the following: ',
    'information-seeking': 'Answer thoroughly: ',
    'task-execution': '',
  }[primaryIntent] || '';
  return quoted ? prefix + '"' + core + '"' : prefix + capitalize(core);
}

function recommendLevel(intake, primaryIntent) {
  const entityCount =
    intake.entities.people.length + intake.entities.systems.length + intake.entities.numbers.length;
  const score =
    entityCount * 2 +
    intake.constraints.length * 3 +
    intake.goals.length * 2 +
    Math.min(intake.sentences.length, 10);
  let level;
  if (score <= 6) level = 1;
  else if (score <= 16) level = 2;
  else if (score <= 30) level = 3;
  else level = 4;
  let reason = 'short, low-entity input — a lean prompt is enough';
  if (level === 2) reason = 'some background and entities worth carrying into the prompt';
  if (level === 3) reason = 'rich constraints and multiple entities warrant domain framing';
  if (level === 4) reason = 'dense, multi-party input — full system-prompt treatment pays off';
  if (['support-resolution', 'planning'].includes(primaryIntent) && level < 3) {
    level = 3;
    reason = primaryIntent + ' benefits from constraints, tone and audience framing';
  }
  if (primaryIntent === 'task-execution' && intake.sentences.length <= 3 && !intake.constraints.length) {
    level = Math.min(level, 1);
    reason = 'single direct task with no constraints — keep it minimal';
  }
  return { level, reason };
}

/* ---------------- 6. Agent 4 — Structure (prompt builders) ---------------- */

const PROMPT_TYPES = [
  { id: 'zero-shot', label: 'Zero-shot' },
  { id: 'few-shot', label: 'Few-shot' },
  { id: 'cot', label: 'Chain-of-thought' },
  { id: 'role', label: 'Role-based' },
  { id: 'json', label: 'JSON output' },
  { id: 'agentic', label: 'Agentic spec' },
];

const FENCE = '```';

function buildAnalysis(intake, intents) {
  const primary = intents[0].name;
  return {
    ...intake,
    intents,
    primaryIntent: primary,
    instruction: synthesizeInstruction(intake, primary),
    domain: guessDomain(intake),
    audience: guessAudience(intake, primary),
    tone: TONES[primary],
    persona: PERSONAS[primary],
    schema: JSON_SCHEMAS[primary],
  };
}

function backgroundBlock(a) {
  const lines = [];
  lines.push('- Source type: ' + a.type + ' (' + a.sentences.length + ' sentences)');
  if (a.entities.people.length) lines.push('- Participants: ' + a.entities.people.join(', '));
  if (a.entities.systems.length) lines.push('- Systems mentioned: ' + a.entities.systems.join(', '));
  if (a.entities.numbers.length) lines.push('- Key figures & dates: ' + a.entities.numbers.slice(0, 6).join(', '));
  if (a.keywords.length) lines.push('- Key topics: ' + a.keywords.slice(0, 6).join(', '));
  if (a.questions.length) lines.push('- Open questions: ' + a.questions.slice(0, 2).join(' | '));
  return '## Background\n' + lines.join('\n');
}

function framingBlock(a) {
  return (
    '## Framing\n' +
    '- Domain: ' + a.domain + '\n' +
    '- Audience: ' + a.audience + '\n' +
    '- Tone: ' + a.tone
  );
}

function constraintsBlock(a) {
  if (!a.constraints.length) return '';
  return '## Constraints\n' + a.constraints.map((c) => '- ' + c).join('\n');
}

function toolsFor(a) {
  const tools = [];
  const seen = new Set();
  const push = (name, args, desc, when) => {
    if (seen.has(name) || tools.length >= 5) return;
    seen.add(name);
    tools.push({ name, args, desc, when });
  };
  const hay = (a.entities.systems.join(' ') + ' ' + a.text).toLowerCase();
  if (/billing|invoice|stripe|payment|subscription|refund|charge/.test(hay)) {
    push('billing.lookup_invoice', '(account_id)', 'Retrieve invoices, charges and refund status for an account.', 'payment or charge facts are needed');
    push('billing.issue_refund', '(charge_id, amount)', 'Issue a refund for a confirmed duplicate or incorrect charge.', 'a refund is justified and verified');
  }
  if (/stripe/.test(hay)) push('payments.create_link', '(amount, description)', 'Generate a payment link for add-on work.', 'a client must pay for extra scope');
  if (/ticket|jira|support|issue/.test(hay)) push('tickets.create', '(title, priority, summary)', 'File a support or engineering ticket.', 'an issue needs tracking or escalation');
  if (/email|gmail|outlook/.test(hay)) push('comms.send_email', '(to, subject, body)', 'Send an email to a customer or teammate.', 'written confirmation or follow-up is requested');
  if (/calendar|meeting|schedule|review/.test(hay)) push('calendar.schedule', '(title, attendees, time)', 'Create a calendar event.', 'a meeting, review or reminder is requested');
  if (/figma|design|mock/.test(hay)) push('assets.get_mockups', '(project)', 'Fetch the latest design mockups for a project.', 'visual specs are required');
  if (/dashboard|tableau|metric|analytics|cohort/.test(hay)) push('metrics.query', '(metric, range)', 'Pull metric values from the analytics store.', 'quantitative evidence is needed');
  if (/database|sql|crm|salesforce|record/.test(hay)) push('records.lookup', '(entity, id)', 'Look up an authoritative record.', 'system-of-record data is required');

  const DEFAULTS = {
    'support-resolution': [
      ['kb.search', '(query)', 'Search the help-center knowledge base.', 'troubleshooting steps are needed'],
      ['tickets.create', '(title, priority, summary)', 'File a support ticket.', 'the issue must be tracked'],
      ['comms.send_email', '(to, subject, body)', 'Email the customer.', 'the customer asked for confirmation'],
    ],
    'planning': [
      ['tasks.create', '(title, owner, due)', 'Create a tracked task with an owner.', 'an action item is identified'],
      ['calendar.schedule', '(title, attendees, time)', 'Schedule a review or checkpoint.', 'a date-driven event is planned'],
      ['comms.notify', '(channel, message)', 'Notify the team in their channel.', 'stakeholders must be kept in the loop'],
    ],
    'creative-generation': [
      ['notes.save', '(title, body)', 'Persist a concept or decision.', 'an idea is worth keeping'],
      ['assets.search', '(query)', 'Search existing assets and references.', 'inspiration or prior art is needed'],
      ['tasks.create', '(title, owner, due)', 'Create a follow-up task.', 'the concept produces next steps'],
    ],
    'code-generation': [
      ['repo.read', '(path)', 'Read a file from the repository.', 'existing code context is required'],
      ['repo.write', '(path, content)', 'Write or update a file.', 'the implementation is ready'],
      ['tests.run', '(suite)', 'Run the test suite.', 'verifying a change'],
    ],
    'data-extraction': [
      ['files.read', '(path)', 'Read a source document.', 'raw content must be inspected'],
      ['records.lookup', '(entity, id)', 'Cross-check a record.', 'validating extracted values'],
      ['sheets.export', '(rows, format)', 'Export extracted rows.', 'the user wants a file'],
    ],
  };
  const defaults = DEFAULTS[a.primaryIntent] || [
    ['kb.search', '(query)', 'Search the knowledge base.', 'factual grounding is needed'],
    ['tasks.create', '(title, owner, due)', 'Create a tracked task.', 'follow-up work is identified'],
    ['comms.notify', '(channel, message)', 'Notify a stakeholder.', 'someone must be informed'],
  ];
  for (const [n, ar, d, w] of defaults) push(n, ar, d, w);
  return tools;
}

function toolsBlock(a) {
  const tools = toolsFor(a);
  return (
    '## Tools available\n' +
    tools
      .map((t, i) => (i + 1) + '. `' + t.name + t.args + '` — ' + t.desc + ' Use when ' + t.when + '.')
      .join('\n')
  );
}

function guardrailsBlock(a) {
  const g = [];
  for (const c of a.constraints.slice(0, 4)) g.push('Respect: ' + c);
  g.push('Never fabricate facts, figures, or account data; use only the source input and tool outputs.');
  g.push('If a required detail is missing, ask one clarifying question before assuming.');
  if (a.primaryIntent === 'support-resolution') {
    g.push('Protect customer data: reference only the last 4 digits of payment instruments, never full numbers.');
  }
  if (a.primaryIntent === 'code-generation') {
    g.push('Do not introduce new dependencies without stating why; keep changes minimal and testable.');
  }
  g.push('Flag out-of-scope requests instead of silently complying.');
  return '## Guardrails\n' + g.map((x) => '- ' + x).join('\n');
}

function schemaBlock(a) {
  return '## Output schema\n' + FENCE + 'json\n' + JSON.stringify(a.schema, null, 2) + '\n' + FENCE;
}

function contextBlock(a, level) {
  if (level <= 1) return '';
  const parts = [backgroundBlock(a)];
  if (level >= 3) {
    parts.push(framingBlock(a));
    const cb = constraintsBlock(a);
    if (cb) parts.push(cb);
  }
  if (level >= 4) {
    parts.push('## Persona\nYou are ' + a.persona + '.');
    parts.push('## Capabilities\n' + capabilitiesLines(a));
    parts.push(guardrailsBlock(a));
    parts.push(toolsBlock(a));
    parts.push(schemaBlock(a));
    parts.push(
      '## Examples\n' +
        buildExamples(a)
          .slice(0, 2)
          .map((e) => 'Input: ' + e.input + '\nOutput: ' + e.output)
          .join('\n\n')
    );
  }
  return parts.join('\n\n');
}

function capabilitiesLines(a) {
  const caps = a.actions.slice(0, 4).map((act) => '- ' + act.replace(/\.$/, ''));
  caps.push('- Ask clarifying questions when the request is ambiguous');
  return caps.join('\n');
}

function requirementsBlock(a, level) {
  const reqs = [];
  if (a.goals.length) reqs.push('Address the primary goal: ' + shorten(a.goals[0], 120));
  if (level >= 2 && a.constraints.length) {
    for (const c of a.constraints.slice(0, 5)) reqs.push('Respect this constraint: ' + c);
  }
  if (level >= 3 && a.entities.systems.length) {
    reqs.push('Reference the relevant systems where applicable: ' + a.entities.systems.slice(0, 4).join(', '));
  }
  reqs.push('If a required detail is missing, state your assumption explicitly before proceeding.');
  return '# Requirements\n' + reqs.map((r) => '- ' + r).join('\n');
}

function sourceBlock(a) {
  return '# Source Input (' + a.type + ')\n"""\n' + shorten(a.text, 1600) + '\n"""';
}

function buildExamples(a) {
  const ex = [];
  const ideal = (i) => {
    const bits = ['Acknowledge the request in one line'];
    const sys = a.entities.systems[i] || a.entities.systems[0];
    if (sys) bits.push('verify the details in ' + sys);
    if (a.actions[i]) bits.push('then ' + a.actions[i].charAt(0).toLowerCase() + a.actions[i].slice(1).replace(/\.$/, ''));
    if (a.constraints[i]) bits.push('respecting the constraint: "' + shorten(a.constraints[i], 90) + '"');
    bits.push('and confirm the outcome with ' + (a.entities.people[0] || 'the requester'));
    return bits.join(', ') + '.';
  };
  if (a.questions[0]) ex.push({ input: a.questions[0], output: ideal(0) });
  if (a.goals[0] && ex.length < 3) {
    ex.push({ input: 'I need help: ' + shorten(a.goals[0], 110), output: ideal(ex.length) });
  }
  if (a.goals[1] && ex.length < 3) {
    ex.push({ input: 'I need help: ' + shorten(a.goals[1], 110), output: ideal(ex.length) });
  }
  if (a.actions[1] && ex.length < 3) {
    ex.push({ input: 'Please ' + a.actions[1].charAt(0).toLowerCase() + a.actions[1].slice(1).replace(/\.$/, '') + '.', output: ideal(ex.length) });
  }
  while (ex.length < 2) {
    ex.push({
      input: 'A request similar to: "' + shorten(a.goals[0] || a.actions[0] || a.instruction, 90) + '"',
      output: ideal(ex.length),
    });
  }
  return ex.slice(0, 3);
}

const GENERATORS = {
  'zero-shot': (a, level) =>
    [
      '# Task',
      a.instruction,
      contextBlock(a, level),
      requirementsBlock(a, level),
      sourceBlock(a),
    ].filter(Boolean).join('\n\n'),

  'few-shot': (a, level) => {
    const examples = buildExamples(a);
    const exText = examples
      .map((e, i) => '### Example ' + (i + 1) + '\nInput: ' + e.input + '\nOutput: ' + e.output)
      .join('\n\n');
    return [
      '# Task',
      a.instruction + '\n\nFollow the pattern shown in the examples below.',
      contextBlock(a, level),
      '# Examples\n' + exText + '\n\n(Examples synthesized from your input — refine before production use.)',
      requirementsBlock(a, level),
      '# Now process this input\nInput:\n"""\n' + shorten(a.text, 1400) + '\n"""\nOutput:',
    ].filter(Boolean).join('\n\n');
  },

  'cot': (a, level) => {
    const facts = a.keywords.slice(0, 5).join(', ') || 'the key facts in the source';
    const constraintLine = a.constraints.length
      ? 'Identify every constraint that must hold (' + a.constraints.length + ' detected, e.g. "' + shorten(a.constraints[0], 70) + '").'
      : 'Identify any constraints that must hold; if none are stated, say so explicitly.';
    return [
      '# Task',
      a.instruction,
      contextBlock(a, level),
      [
        '# Reasoning Procedure',
        'Before answering, work through these steps explicitly:',
        '1. Restate the request in one sentence and name the requester\'s core goal.',
        '2. List the key facts from the source (topics: ' + facts + ').',
        '3. ' + constraintLine,
        '4. Consider 2–3 possible approaches and note the trade-off of each.',
        '5. Choose the best approach and justify it in one line.',
        '6. Produce the final answer.',
        '',
        'Show your reasoning for steps 1–5, then write the final output under "## Final Answer".',
      ].join('\n'),
      sourceBlock(a),
    ].filter(Boolean).join('\n\n');
  },

  'role': (a, level) => {
    return [
      '# Role',
      'You are ' + a.persona + ', with 10+ years of experience in ' + a.domain + '.\nYour audience is ' + a.audience + '. Your tone is ' + a.tone + '.',
      '# Task',
      a.instruction,
      level >= 2 ? contextBlock(a, level) : '',
      requirementsBlock(a, level),
      sourceBlock(a),
    ].filter(Boolean).join('\n\n');
  },

  'json': (a, level) =>
    [
      '# Task',
      a.instruction,
      contextBlock(a, level),
      '# Output Format',
      'Respond ONLY with valid JSON matching this schema — no prose, no markdown fences:',
      FENCE + 'json\n' + JSON.stringify(a.schema, null, 2) + '\n' + FENCE,
      '# Rules',
      '- Use null for any value you cannot determine from the source.\n- Do not invent values that are not in the source input.\n- Keep strings concise (under 200 characters each).',
      sourceBlock(a),
    ].filter(Boolean).join('\n\n'),

  'agentic': (a, level) => {
    const tools = toolsFor(a);
    const agentName = a.domain
      .split(' ')
      .slice(0, 2)
      .map((w) => capitalize(w.replace(/[^a-z]/gi, '')))
      .join('') + 'Agent';
    return [
      '# Agent Spec — ' + agentName,
      '## Mission\n' + a.instruction,
      contextBlock(a, level),
      '## Tools\n' +
        tools.map((t, i) => (i + 1) + '. `' + t.name + t.args + '` — ' + t.desc + ' Use when ' + t.when + '.').join('\n'),
      [
        '## Operating Loop',
        '1. OBSERVE — read the user request and the current state.',
        '2. PLAN — decide which single tool call moves you toward the mission, and why (one line).',
        '3. ACT — call exactly one tool; never invent its output.',
        '4. REFLECT — if the mission is satisfied, compose the final answer; otherwise loop (max 8 iterations).',
      ].join('\n'),
      '## Escalation\n- Escalate to a human when a tool fails twice, when a constraint would be violated, or when the request falls outside the mission.',
      '## Done Criteria\n- ' + (a.goals.length ? shorten(a.goals[0], 120) : 'The user\'s request is verifiably completed and confirmed.'),
      sourceBlock(a),
    ].filter(Boolean).join('\n\n');
  },
};

/* ---------------- 7. Agent 5 — Critic ---------------- */

function critiquePrompt(text, a, level) {
  // Judge the prompt body, not the echoed source input.
  const body = text.split(/# (?:Source Input|Now process)/)[0];
  const dims = {};

  // clarity
  const vague = ['something', 'stuff', 'things', 'maybe', 'whatever', 'somehow', 'etc'];
  const vagueHits = vague.filter((w) => new RegExp('\\b' + w + '\\b', 'i').test(a.instruction));
  const instrWords = a.instruction.split(/\s+/).length;
  let clarity = 94 - vagueHits.length * 12 - (instrWords > 55 ? 12 : 0) - (instrWords > 90 ? 10 : 0);
  dims.clarity = {
    score: clamp(Math.round(clarity), 5, 100),
    tip: vagueHits.length
      ? 'Replace vague terms ("' + vagueHits[0] + '") in the core instruction with concrete nouns.'
      : instrWords > 55
        ? 'Split the core instruction into shorter, single-purpose sentences.'
        : 'Instruction reads clearly.',
  };

  // specificity — do extracted concrete details appear in the prompt body?
  const concrete = dedupe([...a.entities.systems, ...a.entities.people, ...a.entities.numbers]);
  const mentioned = concrete.filter((e) => body.toLowerCase().includes(String(e).toLowerCase()));
  const specRatio = concrete.length ? mentioned.length / concrete.length : 0.4;
  dims.specificity = {
    score: clamp(Math.round(40 + specRatio * 60), 5, 100),
    tip:
      specRatio < 0.6
        ? 'Name specific systems, people or figures in the prompt instead of referring to them implicitly.'
        : 'Concrete entities are well referenced.',
  };

  // context completeness — driven by level and available material
  let ctx = { 1: 46, 2: 68, 3: 86, 4: 95 }[level];
  if (level < 3 && (a.constraints.length || a.goals.length > 1)) ctx -= 8;
  if (level >= 3 && !a.constraints.length) ctx -= 6;
  dims.context = {
    score: clamp(ctx, 5, 100),
    tip:
      level < 3 && (a.constraints.length || a.goals.length > 1)
        ? 'Raise the context level to L3+ to carry constraints and framing into the prompt.'
        : level < 4 && a.entities.systems.length >= 3
          ? 'L4 would add guardrails and tool specs for this system-heavy input.'
          : 'Context coverage matches the selected level.',
  };

  // constraint coverage
  if (!a.constraints.length) {
    dims.constraints = {
      score: 70,
      tip: 'No explicit constraints detected in the input — consider adding limits (time, budget, format).',
    };
  } else {
    const included = a.constraints.filter((c) => body.includes(c));
    const ratio = included.length / a.constraints.length;
    dims.constraints = {
      score: clamp(Math.round(ratio * 100), 5, 100),
      tip:
        ratio < 1
          ? (a.constraints.length - included.length) + ' extracted constraint(s) missing from the prompt — raise the context level.'
          : 'All extracted constraints are carried into the prompt.',
    };
  }

  const avg = Math.round(
    (dims.clarity.score + dims.specificity.score + dims.context.score + dims.constraints.score) / 4
  );
  return { dims, avg };
}

/* ---------------- 8. Pipeline runner + rendering ---------------- */

const state = {
  mode: 'conversation',
  analysis: null,
  level: 2,
  recommendedLevel: 0,
  prompts: {},
  critics: {},
  activeTab: 'zero-shot',
  running: false,
  runs: 0,
};

const els = {};

function cacheEls() {
  Object.assign(els, {
    howItWorksBtn: $('#howItWorksBtn'),
    howItWorks: $('#howItWorks'),
    modeHint: $('#modeHint'),
    micRow: $('#micRow'),
    micBtn: $('#micBtn'),
    micBtnLabel: $('#micBtnLabel'),
    micStatus: $('#micStatus'),
    inputText: $('#inputText'),
    charCount: $('#charCount'),
    clearBtn: $('#clearBtn'),
    runBtn: $('#runBtn'),
    stepper: $('#stepper'),
    latencyStat: $('#latencyStat'),
    runCount: $('#runCount'),
    copyBtn: $('#copyBtn'),
    downloadBtn: $('#downloadBtn'),
    levelAuto: $('#levelAuto'),
    levelFill: $('#levelFill'),
    levelDesc: $('#levelDesc'),
    intentChips: $('#intentChips'),
    promptTabs: $('#promptTabs'),
    criticBadges: $('#criticBadges'),
    criticTip: $('#criticTip'),
    promptOutput: $('#promptOutput'),
    emptyState: $('#emptyState'),
  });
}

function resetStepper() {
  $$('.step', els.stepper).forEach((li) => {
    li.classList.remove('active', 'done');
    $('.step-summary', li).textContent = '';
  });
}

function setStage(id, phase, summary) {
  const li = $('.step[data-stage="' + id + '"]', els.stepper);
  if (!li) return;
  if (phase === 'active') li.classList.add('active');
  if (phase === 'done') {
    li.classList.remove('active');
    li.classList.add('done');
    if (summary) $('.step-summary', li).textContent = summary;
  }
}

function renderIntentChips(intents) {
  const top = intents.filter((i) => i.pct > 0).slice(0, 4);
  els.intentChips.innerHTML = top
    .map(
      (i, idx) =>
        '<span class="intent-chip' + (idx === 0 ? ' primary' : '') + '" style="--pct:' + i.pct + '%; animation-delay:' + idx * 90 + 'ms">' +
        '<span class="bar"></span>' + i.label + '<span class="chip-pct">' + i.pct + '%</span></span>'
    )
    .join('');
}

function renderLevelUI() {
  $$('.level-stop').forEach((btn) => {
    const lvl = Number(btn.dataset.level);
    btn.classList.toggle('selected', lvl === state.level);
    btn.classList.toggle('reco', lvl === state.recommendedLevel);
  });
  els.levelFill.style.width = ((state.level - 1) / 3) * 75 + '%';
  const L = LEVELS[state.level];
  els.levelDesc.innerHTML = '<strong>L' + state.level + ' · ' + L.name + '</strong> — ' + L.desc;
}

function highlightPrompt(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc
    .split('\n')
    .map((line) => {
      if (/^# /.test(line)) return '<span class="tk-h1">' + line + '</span>';
      if (/^## /.test(line)) return '<span class="tk-h2">' + line + '</span>';
      if (/^### /.test(line)) return '<span class="tk-h3">' + line + '</span>';
      if (/^"""/.test(line.trim()) || /^-{3,}$/.test(line.trim())) return '<span class="tk-div">' + line + '</span>';
      if (/^\s*"[^"]+"\s*:/.test(line)) return '<span class="tk-key">' + line + '</span>';
      if (/^- /.test(line)) return '<span class="tk-li">' + line + '</span>';
      if (/^\d+\.\s/.test(line.trim())) return '<span class="tk-num">' + line + '</span>';
      return line;
    })
    .join('\n');
}

function badgeClass(score) {
  return score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad';
}

function renderCritic(critic) {
  const order = [
    ['clarity', 'Clarity'],
    ['specificity', 'Specificity'],
    ['context', 'Context'],
    ['constraints', 'Constraints'],
  ];
  els.criticBadges.innerHTML = order
    .map(([key, label], idx) => {
      const d = critic.dims[key];
      return (
        '<span class="badge ' + badgeClass(d.score) + '" style="animation-delay:' + idx * 70 + 'ms" title="' + d.tip.replace(/"/g, '&quot;') + '">' +
        label + ' <span class="score">' + d.score + '</span></span>'
      );
    })
    .join('');
  // surface the weakest dimension's suggestion
  const weakest = order
    .map(([key, label]) => ({ label, ...critic.dims[key] }))
    .sort((x, y) => x.score - y.score)[0];
  els.criticTip.textContent = weakest.score < 85 ? 'Critic: ' + weakest.tip : '';
}

function renderActivePrompt() {
  const text = state.prompts[state.activeTab] || '';
  els.promptOutput.innerHTML = highlightPrompt(text);
  els.promptOutput.classList.remove('flash');
  void els.promptOutput.offsetWidth; // restart animation
  els.promptOutput.classList.add('flash');
  renderCritic(state.critics[state.activeTab]);
  $$('.prompt-tab', els.promptTabs).forEach((t) => t.classList.toggle('active', t.dataset.type === state.activeTab));
}

function regeneratePrompts() {
  const a = state.analysis;
  if (!a) return;
  state.prompts = {};
  state.critics = {};
  for (const t of PROMPT_TYPES) {
    const text = GENERATORS[t.id](a, state.level);
    state.prompts[t.id] = text;
    state.critics[t.id] = critiquePrompt(text, a, state.level);
  }
  renderActivePrompt();
}

function setLevel(level, fromAgent) {
  state.level = level;
  renderLevelUI();
  if (state.analysis) regeneratePrompts();
  if (fromAgent) {
    els.levelAuto.hidden = false;
  }
}

async function runPipeline() {
  const raw = els.inputText.value.trim();
  if (!raw) {
    els.runBtn.classList.add('shake');
    setTimeout(() => els.runBtn.classList.remove('shake'), 450);
    toast('Add some input first — paste text or load a sample.');
    return;
  }
  if (state.running) return;
  state.running = true;
  els.runBtn.disabled = true;
  els.runBtn.classList.add('running');
  $('.run-label', els.runBtn).textContent = 'Agents working…';

  resetStepper();
  els.emptyState.classList.add('hidden');
  els.intentChips.innerHTML = '<span class="muted">Classifying…</span>';
  els.criticBadges.innerHTML = '';
  els.criticTip.textContent = '';
  const t0 = performance.now();

  // --- Stage 1: Intake ---
  setStage('intake', 'active');
  await delay(rand(500, 750));
  const intake = runIntake(raw, state.mode);
  const entityCount =
    intake.entities.people.length + intake.entities.systems.length + intake.entities.numbers.length;
  setStage(
    'intake', 'done',
    'detected ' + intake.type + ' · ' + intake.sentences.length + ' sentences · ' +
    entityCount + ' entities · ' + intake.constraints.length + ' constraints · ' + intake.goals.length + ' goals'
  );

  // --- Stage 2: Intent ---
  setStage('intent', 'active');
  await delay(rand(500, 750));
  const intents = classifyIntents(intake);
  renderIntentChips(intents);
  setStage(
    'intent', 'done',
    intents[0].label.toLowerCase() + ' ' + intents[0].pct + '% · runner-up ' + intents[1].label.toLowerCase() + ' ' + intents[1].pct + '%'
  );

  // --- Stage 3: Context ---
  setStage('context', 'active');
  await delay(rand(450, 700));
  const reco = recommendLevel(intake, intents[0].name);
  state.recommendedLevel = reco.level;
  setLevel(reco.level, true);
  setStage('context', 'done', 'recommended L' + reco.level + ' — ' + reco.reason);

  // --- Stage 4: Structure ---
  setStage('structure', 'active');
  await delay(rand(600, 850));
  state.analysis = buildAnalysis(intake, intents);
  regeneratePrompts();
  els.copyBtn.disabled = false;
  els.downloadBtn.disabled = false;
  $$('.level-stop').forEach((b) => (b.disabled = false));
  $$('.prompt-tab', els.promptTabs).forEach((b) => (b.disabled = false));
  setStage('structure', 'done', 'generated ' + PROMPT_TYPES.length + ' prompt types at L' + state.level);

  // --- Stage 5: Critic ---
  setStage('critic', 'active');
  await delay(rand(450, 700));
  const avgAll = Math.round(
    Object.values(state.critics).reduce((acc, c) => acc + c.avg, 0) / PROMPT_TYPES.length
  );
  const weakest = Object.entries(state.critics[state.activeTab].dims).sort((x, y) => x[1].score - y[1].score)[0];
  setStage('critic', 'done', 'avg ' + avgAll + '/100 · weakest: ' + weakest[0] + ' ' + weakest[1].score);

  state.runs += 1;
  els.runCount.textContent = String(state.runs);
  els.latencyStat.textContent = Math.round(performance.now() - t0) + ' ms (simulated stages)';

  state.running = false;
  els.runBtn.disabled = false;
  els.runBtn.classList.remove('running');
  $('.run-label', els.runBtn).textContent = 'Run Agent Pipeline';
}

/* ---------------- 9. Input modes, mic, samples ---------------- */

const MODE_HINTS = {
  conversation: 'Paste a chat or support conversation — speaker turns like <code>Name: message</code> are detected automatically.',
  recording: 'Transcribe live with your microphone (Web Speech API), or paste an existing transcript below.',
  idea: 'Jot a rough idea or bullet points — fragments are fine, the agents will structure them.',
};

const MODE_PLACEHOLDERS = {
  conversation: 'Paste a conversation here…\n\ne.g.\nCustomer: My invoice looks wrong…\nAgent: Let me check…',
  recording: 'Paste a transcript here, or use the mic button above…',
  idea: 'Rough idea: …\n- point one\n- point two',
};

function setMode(mode) {
  state.mode = mode;
  $$('.mode-tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  els.modeHint.innerHTML = MODE_HINTS[mode];
  els.inputText.placeholder = MODE_PLACEHOLDERS[mode];
  els.micRow.hidden = mode !== 'recording';
  if (mode !== 'recording' && micState.listening) stopMic();
}

function updateCharCount() {
  const n = els.inputText.value.length;
  els.charCount.textContent = n.toLocaleString() + ' chars';
}

/* --- Web Speech API mic transcription --- */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const micState = { recog: null, listening: false };

function startMic() {
  if (!SpeechRecognition) {
    els.micStatus.textContent =
      'Speech recognition is not supported in this browser (try Chrome/Edge on localhost or HTTPS) — paste a transcript instead.';
    return;
  }
  try {
    const recog = new SpeechRecognition();
    micState.recog = recog;
    recog.lang = 'en-US';
    recog.continuous = true;
    recog.interimResults = true;

    recog.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          els.inputText.value += (els.inputText.value.endsWith('\n') || !els.inputText.value ? '' : '\n') + res[0].transcript.trim() + '\n';
          updateCharCount();
        } else {
          interim += res[0].transcript;
        }
      }
      els.micStatus.textContent = interim ? '…' + interim.slice(-60) : 'Listening…';
    };
    recog.onerror = (e) => {
      const msgs = {
        'not-allowed': 'Microphone access denied — allow mic permission, or paste a transcript instead.',
        'no-speech': 'No speech detected — try again or paste a transcript.',
        'service-not-allowed': 'Speech service unavailable here (needs localhost/HTTPS) — paste a transcript instead.',
      };
      els.micStatus.textContent = msgs[e.error] || 'Mic error (' + e.error + ') — paste a transcript instead.';
      stopMic();
    };
    recog.onend = () => {
      if (micState.listening) {
        // continuous mode can end on silence; reflect the real state
        stopMic();
      }
    };
    recog.start();
    micState.listening = true;
    els.micBtn.classList.add('listening');
    els.micBtnLabel.textContent = 'Stop transcription';
    els.micStatus.textContent = 'Listening… speak now.';
  } catch (err) {
    els.micStatus.textContent = 'Could not start speech recognition — paste a transcript instead.';
  }
}

function stopMic() {
  micState.listening = false;
  if (micState.recog) {
    try { micState.recog.stop(); } catch (e) { /* already stopped */ }
    micState.recog = null;
  }
  els.micBtn.classList.remove('listening');
  els.micBtnLabel.textContent = 'Start mic transcription';
  if (els.micStatus.textContent === 'Listening… speak now.') els.micStatus.textContent = '';
}

/* ---------------- 10. Export ---------------- */

async function copyActivePrompt() {
  const text = state.prompts[state.activeTab];
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied "' + PROMPT_TYPES.find((t) => t.id === state.activeTab).label + '" prompt.');
  } catch (e) {
    // clipboard API can fail on file:// — fall back to a hidden textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast('Copied prompt (fallback).');
    } catch (e2) {
      toast('Copy failed — select the text manually.');
    }
    ta.remove();
  }
}

function downloadMarkdown() {
  const a = state.analysis;
  if (!a) return;
  const L = LEVELS[state.level];
  let md = '# PromptForge Export\n\n';
  md += '- Generated: ' + new Date().toISOString() + '\n';
  md += '- Input mode: ' + state.mode + ' (detected: ' + a.type + ')\n';
  md += '- Primary intent: ' + a.intents[0].label + ' (' + a.intents[0].pct + '%)\n';
  md += '- Context level: L' + state.level + ' — ' + L.name + '\n';
  md += '- Domain: ' + a.domain + '\n\n---\n\n';
  for (const t of PROMPT_TYPES) {
    const c = state.critics[t.id];
    md += '## ' + t.label + ' prompt\n\n';
    md += '_Critic — clarity ' + c.dims.clarity.score + ', specificity ' + c.dims.specificity.score +
      ', context ' + c.dims.context.score + ', constraints ' + c.dims.constraints.score + '_\n\n';
    md += FENCE + 'markdown\n' + state.prompts[t.id] + '\n' + FENCE + '\n\n';
  }
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download =
    'promptforge-' + a.primaryIntent.replace(/[^a-z]+/gi, '-').toLowerCase() + '-L' + state.level + '.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Downloaded markdown bundle (' + PROMPT_TYPES.length + ' prompt types).');
}

/* ---------------- 11. Wiring ---------------- */

function init() {
  cacheEls();

  // prompt-type tabs
  els.promptTabs.innerHTML = PROMPT_TYPES.map(
    (t) => '<button class="prompt-tab" data-type="' + t.id + '" role="tab" disabled>' + t.label + '</button>'
  ).join('');
  $$('.prompt-tab', els.promptTabs).forEach((btn) =>
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.type;
      renderActivePrompt();
    })
  );

  // mode tabs
  $$('.mode-tab').forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)));

  // samples
  $$('.sample').forEach((btn) =>
    btn.addEventListener('click', () => {
      const s = SAMPLES[btn.dataset.sample];
      setMode(s.mode);
      els.inputText.value = s.text;
      updateCharCount();
      toast('Loaded sample: ' + s.label + ' — now run the pipeline.');
    })
  );

  // level slider
  $$('.level-stop').forEach((btn) => {
    btn.disabled = true;
    btn.addEventListener('click', () => {
      if (!state.analysis) return;
      els.levelAuto.hidden = true;
      setLevel(Number(btn.dataset.level), false);
    });
  });
  renderLevelUI();

  // input meta
  els.inputText.addEventListener('input', updateCharCount);
  els.clearBtn.addEventListener('click', () => {
    els.inputText.value = '';
    updateCharCount();
    els.inputText.focus();
  });

  // mic
  els.micBtn.addEventListener('click', () => (micState.listening ? stopMic() : startMic()));

  // run + export
  els.runBtn.addEventListener('click', runPipeline);
  els.copyBtn.addEventListener('click', copyActivePrompt);
  els.downloadBtn.addEventListener('click', downloadMarkdown);

  // how it works
  els.howItWorksBtn.addEventListener('click', () => {
    const open = els.howItWorks.hidden;
    els.howItWorks.hidden = !open;
    els.howItWorksBtn.setAttribute('aria-expanded', String(open));
  });

  setMode('conversation');
  updateCharCount();
}

document.addEventListener('DOMContentLoaded', init);
