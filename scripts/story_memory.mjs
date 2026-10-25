#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ITEM_DIMENSIONS, REVIEW_INTERVALS, gradeForTarget, parseItemTarget, emptyLearner, ensureExtensions, requiredTargets, recordQuizObservations, learningPlan, exposureStats, recyclePlan, reviewPlan } from './learning_model.mjs';
import { vocabularyPlan } from './review_forecast.mjs';

const INTERVALS = REVIEW_INTERVALS;
const STATES = new Set(['teaching', 'awaiting_quiz', 'remediation', 'passed', 'waived']);
const fail = message => { throw new Error(message); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const str = (value, field) => {
  requireValue(typeof value === 'string' && value.trim(), `${field} 必须是非空字符串`);
  return value.trim();
};
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const compact = value => value.trim().replace(/\s+/gu, ' ');
const clip = (value, length = 500) => typeof value === 'string' && value.length > length ? `${value.slice(0, length)}…` : value;
function bounded(value, depth = 0) {
  if (typeof value === 'string') return clip(value, 1600);
  if (depth > 6) return '[更深内容请按需读取档案]';
  if (Array.isArray(value)) return value.slice(0, 30).map(x => bounded(x, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bounded(v, depth + 1)]));
  return value;
}
export function countWords(text) {
  return (String(text).match(/[\p{L}\p{N}]+(?:['’‐‑-][\p{L}\p{N}]+)*/gu) ?? []).length;
}
function dateInZone(timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const part = type => parts.find(x => x.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function validDate(value) {
  requireValue(/^\d{4}-\d{2}-\d{2}$/u.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, '日期必须是有效 YYYY-MM-DD');
  return value;
}
export function addDays(value, days) {
  const date = new Date(`${validDate(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function profileFrom(input = {}) {
  const p = {
    language: 'en', explanationLanguage: 'zh-CN', timezone: 'Asia/Shanghai',
    targetWords: 200, exactWords: false, level: 'A1–A2', levelProvisional: true,
    variant: 'neutral', dailyMinutes: 25, teachingBatchSize: 4, quizBatchSize: 3,
    difficultyPreference: 'adaptive', newVocabularyPreference: 'adaptive', reviewPolicy: 'balanced', ...input,
  };
  if (p.newItemsLimit === undefined) p.newItemsLimit = p.targetWords <= 200 ? 6 : 10;
  if (p.reviewItemsPerDay === undefined) p.reviewItemsPerDay = p.dailyMinutes < 15 ? 3 : 5;
  requireValue(Number.isInteger(p.targetWords) && p.targetWords > 0 && p.targetWords <= 5000, 'targetWords 必须为 1–5000 的整数');
  requireValue(Number.isInteger(p.newItemsLimit) && p.newItemsLimit > 0 && p.newItemsLimit <= 100, 'newItemsLimit 必须为 1–100 的整数');
  requireValue(typeof p.exactWords === 'boolean' && typeof p.levelProvisional === 'boolean', '精确词数与暂定级别必须是布尔值');
  requireValue(Number.isInteger(p.dailyMinutes) && p.dailyMinutes >= 5 && p.dailyMinutes <= 180, 'dailyMinutes 必须为 5–180');
  requireValue(Number.isInteger(p.teachingBatchSize) && p.teachingBatchSize >= 1 && p.teachingBatchSize <= 10, 'teachingBatchSize 必须为 1–10');
  requireValue(Number.isInteger(p.quizBatchSize) && p.quizBatchSize >= 1 && p.quizBatchSize <= 8, 'quizBatchSize 必须为 1–8');
  requireValue(Number.isInteger(p.reviewItemsPerDay) && p.reviewItemsPerDay >= 1 && p.reviewItemsPerDay <= 50, 'reviewItemsPerDay 必须为 1–50');
  requireValue(['balanced', 'strict'].includes(p.reviewPolicy), 'reviewPolicy 必须为 balanced/strict');
  requireValue(['adaptive', 'fixed'].includes(p.difficultyPreference), 'difficultyPreference 必须为 adaptive/fixed');
  requireValue(['adaptive', 'fixed'].includes(p.newVocabularyPreference), 'newVocabularyPreference 必须为 adaptive/fixed');
  for (const key of ['language', 'explanationLanguage', 'timezone', 'level', 'variant']) str(p[key], key);
  dateInZone(p.timezone);
  return p;
}
function validateState(s) {
  requireValue(s && [1, 2].includes(s.schemaVersion) && Number.isInteger(s.revision), '档案 schemaVersion 不支持或格式损坏；保留原件，不自动重建');
  requireValue(Array.isArray(s.episodes) && Array.isArray(s.quizzes) && s.items && s.events && Array.isArray(s.waivers), '档案结构不完整');
  // Courses created before review policies existed retain their original strict gate.
  s.profile = profileFrom({ reviewPolicy: 'strict', ...s.profile });
  for (const e of s.episodes) requireValue(STATES.has(e.status), '档案包含未知的课程阶段');
  s._upgradeNeeded = s.schemaVersion === 1;
  s.schemaVersion = 2;
  return ensureExtensions(s);
}
async function readState(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') fail('档案不存在；只有确定是新课程时才使用 init');
    throw error;
  }
  try { return validateState(JSON.parse(text.replace(/^\uFEFF/u, ''))); }
  catch (error) { fail(`档案读取失败：${error.message}。请检查原件及 .bak，停止覆盖。`); }
}
function latest(s) { return s.episodes.at(-1); }
function dueItems(s, today) {
  return Object.values(s.items).filter(i => i.deferredOn !== today && (i.needsRepair || i.requestedReview || i.nextReviewOn <= today))
    .sort((a, b) => a.nextReviewOn.localeCompare(b.nextReviewOn) || a.id.localeCompare(b.id));
}
function blockers(s, today) {
  const reasons = [];
  if (s.pendingQuizId) reasons.push('有待答或未批改完成的测验');
  if (latest(s) && !['passed', 'waived'].includes(latest(s).status)) reasons.push(`当前集尚未完成：${latest(s).status}`);
  const due = dueItems(s, today);
  const plan = reviewPlan(s, today, due);
  if (s.profile.reviewPolicy === 'strict' && due.length) reasons.push(`有 ${due.length} 项到期复习或错题补测`);
  else {
    if (plan.requiredCount) reasons.push(`本日还需优先复习 ${plan.requiredCount} 项；其余到期项保留在复习队列`);
    if (plan.repairCount) reasons.push(`本日复习有 ${plan.repairCount} 项错误尚待独立修复`);
  }
  return reasons;
}
function itemView(i) {
  return { id: i.id, kind: i.kind, term: i.term, sense: i.sense, meaning: clip(i.meaning, 200), stage: i.stage, nextReviewOn: i.nextReviewOn, needsRepair: i.needsRepair, requestedReview: Boolean(i.requestedReview), mastery: i.mastery, exposure: exposureStats(i) };
}
function summary(s, today, limit) {
  const e = latest(s), q = s.quizzes.find(x => x.id === s.pendingQuizId), due = dueItems(s, today);
  const reasons = blockers(s, today);
  return {
    schemaVersion: s.schemaVersion, revision: s.revision, courseId: s.courseId, title: s.title, today, updatedAt: s.updatedAt,
    upgradeNeeded: s._upgradeNeeded, profile: bounded(s.profile), learningPlan: learningPlan(s), vocabularyPlan: vocabularyPlan(s, today), recyclePlan: recyclePlan(s, today), reviewPlan: reviewPlan(s, today, due), premise: clip(s.bible.premise ?? '', 500),
    latest: e ? { id: e.id, title: e.title, serial: e.serial ?? null, status: e.status, wordCount: e.wordCount, taughtThrough: e.taughtThrough, sentenceCount: e.sentences.length, focusTaught: e.focusTaught, teachingOmission: e.teachingOmission ? bounded(e.teachingOmission) : null, focus: e.focusIds.slice(0, limit).map(id => itemView(s.items[id])), focusCount: e.focusIds.length, focusHasMore: e.focusIds.length > limit, masteredCount: e.requiredTargets.filter(t => e.masteredTargets.includes(t)).length, requiredTargetCount: e.requiredTargets.length, missingTargets: e.requiredTargets.filter(t => !e.masteredTargets.includes(t)), recap: clip(e.recap, 600) } : null,
    pendingQuiz: q ? { id: q.id, scope: q.scope, questionCount: q.questions.length, answeredCount: Object.keys(q.marks).length, remainingCount: q.questions.length - Object.keys(q.marks).length, nextQuestionIds: q.questions.filter(x => !Object.hasOwn(q.marks, x.id)).slice(0, s.profile.quizBatchSize).map(x => x.id), remainingQuestionIds: q.questions.filter(x => !Object.hasOwn(q.marks, x.id)).map(x => x.id) } : null,
    dueCount: due.length, due: due.slice(0, limit).map(itemView), dueHasMore: due.length > limit,
    readyForNext: reasons.length === 0, blockers: reasons,
  };
}
function paginate(values, offset, limit) {
  return { total: values.length, offset, hasMore: offset + limit < values.length, records: bounded(values.slice(offset, offset + limit)) };
}
function fieldPage(root, field, offset, limit) {
  let value = root;
  if (field) for (const part of field.split('.')) {
    requireValue(value && typeof value === 'object' && Object.hasOwn(value, part), `不存在的字段：${field}`);
    value = value[part];
  }
  if (Array.isArray(value)) return { field: field ?? '', ...paginate(value, offset, limit) };
  if (typeof value === 'string') return { field, totalChars: value.length, offset, text: value.slice(offset, offset + 1600), hasMore: offset + 1600 < value.length };
  if (value && typeof value === 'object') return { field: field ?? '', ...paginate(Object.entries(value).map(([key, entry]) => ({ field: field ? `${field}.${key}` : key, type: Array.isArray(entry) ? 'array' : typeof entry, total: Array.isArray(entry) ? entry.length : typeof entry === 'string' ? entry.length : entry && typeof entry === 'object' ? Object.keys(entry).length : null, preview: typeof entry === 'string' ? clip(entry, 200) : typeof entry === 'object' ? undefined : entry })), offset, limit) };
  return { field, value };
}
function mergeBible(bible, update) {
  requireValue(update && typeof update === 'object' && !Array.isArray(update), 'bibleUpdate 必须为对象');
  const result = { ...bible };
  for (const [key, value] of Object.entries(update)) {
    if (['timeline', 'worldRules', 'cast', 'openThreads'].includes(key) && Array.isArray(value)) {
      const entries = Array.isArray(result[key]) ? structuredClone(result[key]) : [];
      for (const entry of value) {
        const at = entry && typeof entry === 'object' && entry.id ? entries.findIndex(x => x && typeof x === 'object' && x.id === entry.id) : entries.findIndex(x => JSON.stringify(x) === JSON.stringify(entry));
        if (at < 0) entries.push(entry);
        else if (entry && typeof entry === 'object') entries[at] = { ...entries[at], ...entry };
      }
      result[key] = entries;
    } else if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) result[key] = { ...result[key], ...value };
    else result[key] = value;
  }
  return result;
}
function show(s, options) {
  const { section = 'sentences', offset = 0, limit = 10, episode, field, quiz } = options;
  const e = episode ? s.episodes.find(x => x.id === episode) : latest(s);
  if (section === 'bible') return fieldPage(s.bible, field, offset, limit);
  if (section === 'learner') return fieldPage(s.learner, field, offset, limit);
  if (section === 'items') return paginate(Object.values(s.items), offset, limit);
  if (section === 'quizzes') return paginate(s.quizzes.map(q => ({ id: q.id, scope: q.scope, status: q.status, episodeId: q.episodeId, result: q.result, date: q.date })), offset, limit);
  if (['quiz', 'grading', 'next-questions', 'corrections', 'assessment-notes'].includes(section)) {
    const q = quiz ? s.quizzes.find(x => x.id === quiz) : s.quizzes.find(x => x.id === s.pendingQuizId) ?? s.quizzes.at(-1);
    requireValue(q, '当前没有测验');
    if (section === 'corrections' || section === 'assessment-notes') return { id: q.id, ...paginate(section === 'corrections' ? q.corrections ?? [] : q.assessmentNotes ?? [], offset, limit) };
    const selected = section === 'next-questions' ? q.status === 'pending' ? q.questions.filter(x => !Object.hasOwn(q.marks, x.id)) : [] : q.questions;
    const questions = selected.map(x => section === 'grading' ? { ...x, mark: Object.hasOwn(q.marks, x.id) ? q.marks[x.id] : null } : { id: x.id, prompt: x.prompt, responseLanguage: x.responseLanguage ?? 'flexible', targets: x.targets, answered: Object.hasOwn(q.marks, x.id) });
    return { id: q.id, scope: q.scope, ...paginate(questions, offset, limit) };
  }
  requireValue(e, '尚未写入故事集');
  if (section === 'sentences') return { id: e.id, taughtThrough: e.taughtThrough, ...paginate(e.sentences, offset, limit) };
  if (section === 'focus') return paginate(e.focusIds.map(id => s.items[id]), offset, limit);
  if (section === 'story') return { id: e.id, title: e.title, wordCount: e.wordCount, story: clip(e.story, 8000), storyTruncated: e.story.length > 8000, recap: clip(e.recap, 600) };
  fail('未知 section；可用 bible/learner/items/quizzes/quiz/next-questions/grading/sentences/focus/story');
}
function upsertItem(s, input, today, source) {
  const term = str(input.term, 'term'), sense = str(input.sense, 'sense'), meaning = str(input.meaning, 'meaning');
  const kind = input.kind ?? 'word';
  requireValue(['word', 'phrase', 'pattern'].includes(kind), 'kind 必须为 word/phrase/pattern');
  const id = `V${hash([s.profile.language, kind, normalized(term), normalized(sense)].join('|')).slice(0, 16)}`;
  const existing = s.items[id];
  const info = { term, kind, sense, meaning, pronunciation: input.pronunciation ?? '', usage: input.usage ?? '', memory: input.memory ?? '', example: input.example ?? '' };
  if (existing) {
    Object.assign(existing, Object.fromEntries(Object.entries(info).filter(([, value]) => value !== '')));
    existing.sources.push({ ...source, date: today });
  } else {
    s.items[id] = { id, ...info, stage: -1, nextReviewOn: today, needsRepair: false, lastAdvancedOn: null, lastReviewedOn: null, lapses: 0, history: [], sources: [{ ...source, date: today }], mastery: Object.fromEntries(ITEM_DIMENSIONS.map(d => [d, null])), exposures: [] };
  }
  return id;
}
function schedule(s, id, grade, today, quizId) {
  const i = s.items[id];
  requireValue(i && [0, 1, 2].includes(grade), '复习词条或等级无效');
  const before = { stage: i.stage, nextReviewOn: i.nextReviewOn };
  const wasDue = i.needsRepair || i.requestedReview || i.nextReviewOn <= today;
  if (grade === 0) {
    i.stage = -1; i.nextReviewOn = addDays(today, 1); i.needsRepair = true; i.lapses += 1;
  } else if (grade === 1) {
    i.nextReviewOn = addDays(today, 1); i.needsRepair = true;
  } else {
    const eligible = i.stage < 0 || i.nextReviewOn <= today || i.needsRepair;
    if (eligible) {
      if (i.lastAdvancedOn !== today) i.stage = Math.min(i.stage + 1, INTERVALS.length - 1);
      i.stage = Math.max(0, i.stage);
      // Repair restores a one-day interval; early correct reviews keep their existing due date.
      if (i.needsRepair) i.stage = 0;
      i.nextReviewOn = addDays(today, INTERVALS[i.stage]);
      i.lastAdvancedOn = today;
    }
    i.needsRepair = false;
  }
  i.lastReviewedOn = today;
  i.requestedReview = false;
  delete i.deferredOn;
  i.history.push({ date: today, quizId, grade, wasDue, before, after: { stage: i.stage, nextReviewOn: i.nextReviewOn } });
}
const ASSESSMENT_FIELDS = ['stage', 'nextReviewOn', 'needsRepair', 'lastAdvancedOn', 'lastReviewedOn', 'lapses', 'mastery', 'requestedReview', 'requestedReviewOn', 'deferredOn'];
function assessmentSnapshot(item) {
  return structuredClone(Object.fromEntries(ASSESSMENT_FIELDS.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]])));
}
function normalizeMark(question, m, date) {
  requireValue([0, 1, 2].includes(m.score), 'score 必须为 0/1/2');
  const assistance = m.assistance ?? 'none';
  requireValue(['none', 'hint', 'answer_seen'].includes(assistance), 'assistance 必须为 none/hint/answer_seen');
  let targetMarks;
  if (m.targetMarks !== undefined) {
    requireValue(m.targetMarks && typeof m.targetMarks === 'object' && !Array.isArray(m.targetMarks) && Object.keys(m.targetMarks).length === question.targets.length && question.targets.every(t => Object.hasOwn(m.targetMarks, t)), 'targetMarks 必须恰好覆盖本题全部目标');
    targetMarks = Object.fromEntries(question.targets.map(target => {
      const detail = m.targetMarks[target];
      requireValue(detail && [0, 1, 2].includes(detail.score) && ['none', 'hint', 'answer_seen'].includes(detail.assistance ?? 'none'), '目标评分须含合法 score/assistance');
      return [target, { score: detail.score, assistance: detail.assistance ?? 'none', feedback: str(detail.feedback, '目标 feedback') }];
    }));
    requireValue(m.score === Math.min(...Object.values(targetMarks).map(x => x.score)), '整体 score 须为目标原始分的最低值');
  }
  return { answer: str(m.answer, '用户真实 answer'), score: m.score, assistance, feedback: str(m.feedback, 'feedback'), date, ...(targetMarks ? { targetMarks } : {}) };
}
const expressionTarget = target => parseItemTarget(target)?.dimension === 'production' || target === 'transfer' || target.startsWith('goal:expression:');
function validateResponseEvidence(s, q, question, mark) {
  if (q.evidenceContract !== 1 || !/^en(?:-|$)/iu.test(s.profile.language)) return;
  const hasExpression = question.targets.some(expressionTarget);
  const independentEnglish = question.targets.some(target => (expressionTarget(target) || (!hasExpression && question.responseLanguage === 'en')) && gradeForTarget(mark, target) === 2);
  requireValue(!independentEnglish || /\p{Script=Latin}/u.test(mark.answer), '英语表达目标必须有实际英语作答；仅中文自述不能记为独立通过。脚本只检查证据缺失，语义仍由教师批改');
}
function applyQuizItems(s, q) {
  if (q.scope === 'practice') return;
  const itemIds = [...new Set(q.questions.flatMap(x => x.targets.map(parseItemTarget).filter(Boolean).map(t => t.id)))];
  q.itemSnapshots ??= {};
  for (const id of itemIds) {
    const relevant = q.questions.filter(x => x.targets.some(t => parseItemTarget(t)?.id === id));
    if (q.appliedItemIds.includes(id) || relevant.some(x => !Object.hasOwn(q.marks, x.id))) continue;
    const before = assessmentSnapshot(s.items[id]);
    const evidenceDate = relevant.map(x => q.marks[x.id].date).sort().at(-1);
    const itemGrade = Math.min(...relevant.flatMap(x => x.targets.filter(t => parseItemTarget(t)?.id === id).map(t => gradeForTarget(q.marks[x.id], t))));
    for (const dimension of ITEM_DIMENSIONS) {
      const dimensionQuestions = relevant.filter(x => x.targets.includes(`item:${id}:${dimension}`));
      if (!dimensionQuestions.length) continue;
      s.items[id].mastery[dimension] = { grade: Math.min(...dimensionQuestions.map(x => gradeForTarget(q.marks[x.id], `item:${id}:${dimension}`))), date: dimensionQuestions.map(x => q.marks[x.id].date).sort().at(-1), quizId: q.id };
    }
    const outstanding = ITEM_DIMENSIONS.some(d => s.items[id].mastery[d] && s.items[id].mastery[d].grade < 2);
    schedule(s, id, itemGrade === 2 && outstanding ? 1 : itemGrade, evidenceDate, q.id);
    q.itemSnapshots[id] = { before, after: assessmentSnapshot(s.items[id]) };
    q.appliedItemIds.push(id);
  }
}
function finishQuiz(s, q, today, reassessment = false) {
  const remaining = q.questions.filter(x => !Object.hasOwn(q.marks, x.id));
  if (remaining.length) return { quizId: q.id, status: 'pending', remainingQuestionIds: remaining.map(x => x.id), recordedItemIds: q.appliedItemIds };
  const targetGrades = new Map();
  for (const question of q.questions) for (const target of question.targets) targetGrades.set(target, Math.min(targetGrades.get(target) ?? 2, gradeForTarget(q.marks[question.id], target)));
  let episodeStatus = null;
  if (q.scope === 'lesson') {
    const e = s.episodes.find(x => x.id === q.episodeId);
    const mastered = new Set(reassessment ? q.episodeTargetsBefore : e.masteredTargets);
    for (const [target, grade] of targetGrades) { if (grade === 2) mastered.add(target); else mastered.delete(target); }
    e.masteredTargets = [...mastered];
    e.status = e.requiredTargets.every(t => mastered.has(t)) ? 'passed' : 'remediation';
    q.episodeTargetsAfter = [...e.masteredTargets];
    episodeStatus = e.status;
  }
  q.status = 'graded'; q.completedOn ??= today;
  q.result = { points: Object.values(q.marks).reduce((n, m) => n + m.score, 0), maximum: q.questions.length * 2, independentTargetsCount: [...targetGrades.values()].filter(g => g === 2).length, totalTargetsCount: targetGrades.size, independentFullMarks: [...targetGrades.values()].every(g => g === 2), episodeStatus };
  if (!reassessment) recordQuizObservations(s, q);
  s.pendingQuizId = null;
  return { quizId: q.id, ...q.result, readyForNext: blockers(s, today).length === 0 };
}
function mutateState(command, s, payload, today) {
  if (command === 'migrate') return { schemaVersion: 2, preservedEpisodes: s.episodes.length, preservedQuizzes: s.quizzes.length };
  if (command === 'configure') {
    const patch = payload.patch ?? {};
    const allowed = new Set(['targetWords', 'exactWords', 'newItemsLimit', 'level', 'levelProvisional', 'variant', 'timezone', 'explanationLanguage', 'dailyMinutes', 'teachingBatchSize', 'quizBatchSize', 'difficultyPreference', 'newVocabularyPreference', 'reviewPolicy', 'reviewItemsPerDay']);
    requireValue(Object.keys(patch).every(k => allowed.has(k)), 'configure 包含未知字段；改变学习语言请新建课程');
    s.profile = profileFrom({ ...s.profile, ...patch });
    return { profile: s.profile };
  }
  if (command === 'items') {
    requireValue(Array.isArray(payload.items) && payload.items.length > 0, 'items 必须是非空数组');
    const request = str(payload.userRequest, 'userRequest（用户指定生词的原请求）');
    return { items: payload.items.map(i => {
      const id = upsertItem(s, i, today, { type: 'user', request });
      s.items[id].requestedReview = true; s.items[id].requestedReviewOn = today;
      return itemView(s.items[id]);
    }) };
  }
  if (command === 'episode') {
    const reasons = blockers(s, today);
    requireValue(reasons.length === 0, `下一集未解锁：${reasons.join('；')}`);
    const story = str(payload.story, 'story'), wordCount = countWords(story);
    const tolerance = s.profile.exactWords ? 0 : Math.floor(s.profile.targetWords * 0.05);
    requireValue(Math.abs(wordCount - s.profile.targetWords) <= tolerance, `正文词数 ${wordCount}，目标 ${s.profile.targetWords}，允许误差 ${tolerance}`);
    requireValue(Array.isArray(payload.sentences) && payload.sentences.length > 0, '必须提供覆盖全文的 sentences');
    const sentences = payload.sentences.map((x, index) => Object.fromEntries([['id', `S${String(index + 1).padStart(2, '0')}`], ...['english', 'meaning', 'chunks', 'grammar', 'words'].map(k => [k, str(x[k], `sentences.${index}.${k}`)])]));
    requireValue(compact(sentences.map(x => x.english).join(' ')) === compact(story), '教学句子必须按顺序完整覆盖原文，拼写标点一致');
    requireValue(Array.isArray(payload.focus) && payload.focus.length > 0 && payload.focus.length <= s.profile.newItemsLimit, 'focus 数量须为 1 到 newItemsLimit；可先 configure 调整');
    const id = `E${String(s.episodes.length + 1).padStart(4, '0')}`;
    const focusIds = payload.focus.map(i => {
      for (const k of ['pronunciation', 'usage', 'memory', 'example']) str(i[k], `focus.${k}`);
      return upsertItem(s, i, today, { type: 'episode', episodeId: id });
    });
    requireValue(new Set(focusIds).size === focusIds.length, '本集 focus 包含重复词条');
    requireValue(payload.reusedIds === undefined || Array.isArray(payload.reusedIds), 'reusedIds 必须为数组');
    const reusedIds = [...new Set(payload.reusedIds ?? [])];
    requireValue(reusedIds.every(v => s.items[v]), 'reusedIds 只能引用已有词条');
    for (const reusedId of reusedIds) s.items[reusedId].sources.push({ type: 'exposure', episodeId: id, date: today });
    const reuseContexts = payload.reuseContexts ?? [];
    requireValue(Array.isArray(reuseContexts), 'reuseContexts 必须为数组');
    for (const context of reuseContexts) {
      requireValue(reusedIds.includes(context.itemId) && sentences.some(x => x.id === context.sentenceId && x.english === context.example), '词汇复现须引用本集实际句子与 reusedIds');
      s.items[context.itemId].exposures.push({ episodeId: id, sentenceId: context.sentenceId, example: context.example, contextTag: str(context.contextTag, 'contextTag'), date: today });
    }
    const goals = payload.learningGoals ?? [];
    requireValue(Array.isArray(goals) && goals.every(g => ['comprehension', 'grammar', 'expression'].includes(g.kind) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/u.test(g.id) && typeof g.description === 'string' && g.description.trim()), 'learningGoals 需包含合法 kind/id/description');
    requireValue(new Set(goals.map(g => `${g.kind}:${g.id}`)).size === goals.length, 'learningGoals 重复');
    const previous = latest(s)?.serial;
    const serial = { arcId: previous?.arcId ?? 'arc-1', chapterId: previous?.chapterId ?? 'chapter-1', sceneId: previous?.sceneId ?? 'scene-1', sceneStatus: 'open', ...payload.serial };
    for (const key of ['arcId', 'chapterId', 'sceneId']) str(serial[key], `serial.${key}`);
    requireValue(['open', 'closed'].includes(serial.sceneStatus), 'sceneStatus 必须为 open/closed');
    serial.segment = previous && ['arcId', 'chapterId', 'sceneId'].every(key => previous[key] === serial[key]) ? previous.segment + 1 : 1;
    const e = { id, title: str(payload.title, 'title'), story, wordCount, sentences, focusIds, reusedIds, reuseContexts, serial, learningGoals: goals, recap: str(payload.recap, 'recap'), bibleUpdate: payload.bibleUpdate ?? {}, status: 'teaching', taughtThrough: 0, focusTaught: false, requiredTargets: requiredTargets(focusIds, goals), masteredTargets: [], date: today };
    s.episodes.push(e);
    if (payload.bibleUpdate) {
      s.bible = mergeBible(s.bible, payload.bibleUpdate);
    }
    return { episodeId: id, wordCount, serial, status: e.status, focus: focusIds.map(v => itemView(s.items[v])), requiredTargets: e.requiredTargets };
  }
  if (command === 'teach') {
    const e = latest(s);
    const supplementary = e?.teachingOmission && ['awaiting_quiz', 'remediation', 'passed'].includes(e.status);
    requireValue(e && (e.status === 'teaching' || supplementary), '只有 teaching 或明确省略后补讲的阶段可更新教学断点');
    const through = payload.throughSentence ?? e.taughtThrough;
    requireValue(Number.isInteger(through) && through >= e.taughtThrough && through <= e.sentences.length, 'throughSentence 必须单调推进且不能超出全文');
    requireValue(payload.focusTaught === undefined || typeof payload.focusTaught === 'boolean', 'focusTaught 必须为布尔值');
    e.taughtThrough = through;
    e.focusTaught ||= payload.focusTaught === true;
    if (!supplementary && e.taughtThrough === e.sentences.length && e.focusTaught) e.status = 'awaiting_quiz';
    return { episodeId: e.id, status: e.status, taughtThrough: through, focusTaught: e.focusTaught };
  }
  if (command === 'skip-teaching') {
    const e = latest(s), userRequest = str(payload.userRequest, 'userRequest（明确自学或省略剩余讲解、直接测验的原请求）'), reason = str(payload.reason, 'reason');
    requireValue(e && e.status === 'teaching', '只可省略当前尚未完成的讲解，不能跳过正式考核或改写已通过记录');
    if (s.pendingQuizId) {
      const q = s.quizzes.find(x => x.id === s.pendingQuizId);
      requireValue(q?.scope === 'practice' && payload.cancelPractice === true, '有待答练习，只有用户明确取消该随堂练习时才能省略讲解');
      q.status = 'dismissed'; q.dismissal = { userRequest, reason, date: today }; s.pendingQuizId = null;
    }
    e.teachingOmission = { date: today, userRequest, reason, taughtThrough: e.taughtThrough, focusTaught: e.focusTaught };
    e.status = 'awaiting_quiz';
    return { episodeId: e.id, status: e.status, teachingOmitted: true, taughtThrough: e.taughtThrough, focusTaught: e.focusTaught, passed: false };
  }
  if (command === 'quiz') {
    requireValue(!s.pendingQuizId, '已有待答测验，请接续原题');
    const scope = payload.scope ?? 'lesson', e = latest(s);
    requireValue(['lesson', 'review', 'practice'].includes(scope), 'scope 必须为 lesson/review/practice');
    if (scope === 'lesson') {
      requireValue(e && ['awaiting_quiz', 'remediation'].includes(e.status), '先完成全文与重点词讲解，再出当集测验');
      if (e.status === 'remediation') str(payload.reteachNotes, 'reteachNotes（本次补讲内容）');
    }
    if (scope === 'practice') requireValue(e && ['teaching', 'awaiting_quiz', 'remediation'].includes(e.status), '随堂练习需要当前学习片段');
    requireValue(Array.isArray(payload.questions) && payload.questions.length > 0 && payload.questions.length <= 100, 'questions 须为 1–100 个独立可评分小题');
    const allowed = scope !== 'review' ? new Set(e.requiredTargets) : new Set(Object.keys(s.items).flatMap(id => [`item:${id}`, ...ITEM_DIMENSIONS.map(d => `item:${id}:${d}`)]));
    const questions = payload.questions.map((q, index) => {
      requireValue(Array.isArray(q.targets) && q.targets.length > 0 && q.targets.every(t => allowed.has(t)), `第 ${index + 1} 题 targets 无效`);
      const questionId = q.id ? str(q.id, 'question.id') : `Q${index + 1}`;
      requireValue(/^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/u.test(questionId), '题号须为字母数字开头的短标识');
      const responseLanguage = q.responseLanguage ?? (/^en(?:-|$)/iu.test(s.profile.language) && q.targets.some(expressionTarget) ? 'en' : 'flexible');
      requireValue(['en', 'zh-CN', 'flexible'].includes(responseLanguage), 'responseLanguage 必须为 en/zh-CN/flexible');
      requireValue(!(/^en(?:-|$)/iu.test(s.profile.language) && q.targets.some(expressionTarget)) || responseLanguage !== 'zh-CN', '英语表达目标不能设为仅中文作答');
      return { id: questionId, prompt: str(q.prompt, 'prompt'), expected: str(q.expected, 'expected'), criteria: str(q.criteria, 'criteria'), responseLanguage, targets: [...new Set(q.targets)] };
    });
    requireValue(new Set(questions.map(q => q.id)).size === questions.length, '题号重复');
    if (scope === 'lesson') {
      const covered = new Set(questions.flatMap(q => q.targets));
      requireValue(e.requiredTargets.filter(t => !e.masteredTargets.includes(t)).every(t => covered.has(t)), '测验必须覆盖全部尚未通过的必学目标');
    }
    const id = `T${String(s.quizzes.length + 1).padStart(4, '0')}`;
    s.quizzes.push({ id, scope, evidenceContract: 1, episodeId: scope === 'review' ? null : e.id, questions, marks: {}, appliedItemIds: [], itemSnapshots: {}, ...(scope === 'lesson' ? { episodeTargetsBefore: [...e.masteredTargets] } : {}), reteachNotes: payload.reteachNotes ?? '', status: 'pending', date: today });
    s.pendingQuizId = id;
    return { quizId: id, scope, questionCount: questions.length, status: 'pending' };
  }
  if (command === 'answer') {
    const q = s.quizzes.find(x => x.id === s.pendingQuizId);
    requireValue(q && q.status === 'pending', '没有待答测验；不能仅凭自述更新掌握');
    requireValue(payload.quizId === q.id, 'quizId 与当前待答测验不一致');
    requireValue(Array.isArray(payload.marks) && payload.marks.length > 0, '必须给出真实回答与逐题批改');
    const markedIds = new Set();
    for (const m of payload.marks) {
      const question = q.questions.find(x => x.id === m.questionId);
      requireValue(question && !Object.hasOwn(q.marks, m.questionId) && !markedIds.has(m.questionId), '题号未知、重复或已批改');
      q.marks[m.questionId] = normalizeMark(question, m, today);
      validateResponseEvidence(s, q, question, q.marks[m.questionId]);
      markedIds.add(m.questionId);
    }
    applyQuizItems(s, q);
    return finishQuiz(s, q, today);
  }
  if (command === 'reassess') {
    const q = s.quizzes.at(-1), reason = str(payload.reason, 'reason（复核原答案与判据的原因）');
    requireValue(q && payload.quizId === q.id && ['pending', 'graded'].includes(q.status), '只可复核最近一份待答或已批改试卷；已有后续试卷或跳过状态时不可回滚');
    if (q.scope === 'lesson') {
      const e = latest(s);
      requireValue(e?.id === q.episodeId && e.status !== 'waived' && Array.isArray(q.episodeTargetsBefore), '只能复核当前集且具有原目标快照的考核；不能改写已发生的后续剧情');
      if (q.episodeTargetsAfter) requireValue(JSON.stringify(e.masteredTargets) === JSON.stringify(q.episodeTargetsAfter), '当集目标已在本试卷后变更，不可回滚');
    }
    requireValue(Array.isArray(payload.marks) && payload.marks.length > 0, '必须指定已答题的更正评分');
    const changed = new Set(), affectedItems = new Set(), corrections = [];
    for (const m of payload.marks) {
      const question = q.questions.find(x => x.id === m.questionId), original = q.marks[m.questionId];
      requireValue(question && original && !changed.has(m.questionId), '只能复核已答题，题号不可重复');
      requireValue(Object.keys(m).every(k => ['questionId', 'score', 'feedback', 'targetMarks'].includes(k)), '复核只可更正评分和反馈，不能改写原回答、日期或提示证据');
      const corrected = normalizeMark(question, { ...original, ...m }, original.date);
      validateResponseEvidence(s, q, question, corrected);
      for (const target of question.targets) requireValue((corrected.targetMarks?.[target]?.assistance ?? 'none') === (original.targetMarks?.[target]?.assistance ?? 'none'), '不能更改目标提示证据来制造独立掌握');
      corrections.push({ questionId: m.questionId, before: structuredClone(original), after: corrected, reason, date: today });
      for (const target of question.targets) { const item = parseItemTarget(target); if (item) affectedItems.add(item.id); }
      changed.add(m.questionId);
    }
    for (const id of affectedItems) if (q.appliedItemIds.includes(id)) {
      const snapshot = q.itemSnapshots?.[id], item = s.items[id];
      requireValue(snapshot && item.history.at(-1)?.quizId === q.id && JSON.stringify(assessmentSnapshot(item)) === JSON.stringify(snapshot.after), '词条缺少原评分快照或已有后续变化，不能安全回滚；先保存复核说明并按最新证据学习');
      for (const key of ASSESSMENT_FIELDS) { if (Object.hasOwn(snapshot.before, key)) item[key] = structuredClone(snapshot.before[key]); else delete item[key]; }
      item.history.pop();
      q.appliedItemIds = q.appliedItemIds.filter(x => x !== id);
    }
    for (const correction of corrections) q.marks[correction.questionId] = correction.after;
    q.corrections ??= []; q.corrections.push(...corrections);
    applyQuizItems(s, q);
    const result = finishQuiz(s, q, today, true);
    // Replace the old observation rather than counting a corrected answer twice.
    s.learner = emptyLearner();
    for (const quiz of s.quizzes) if (quiz.status === 'graded') recordQuizObservations(s, quiz);
    return { ...result, correctedQuestionIds: [...changed], evidenceDates: [...new Set(corrections.map(c => c.before.date))], correctionDate: today };
  }
  if (command === 'assessment-note') {
    const q = s.quizzes.find(x => x.id === payload.quizId);
    requireValue(q, '找不到要附复核说明的试卷');
    const note = { date: today, reason: str(payload.reason, 'reason'), note: str(payload.note, 'note（原答案与判据的具体复核结论）') };
    q.assessmentNotes ??= []; q.assessmentNotes.push(note);
    return { quizId: q.id, notesCount: q.assessmentNotes.length, scoresChanged: false };
  }
  if (command === 'dismiss') {
    const q = s.quizzes.find(x => x.id === s.pendingQuizId);
    requireValue(q && q.scope === 'practice' && q.status === 'pending' && payload.quizId === q.id, 'dismiss 只可取消当前待答随堂练习，不可取消正式考核');
    q.dismissal = { userRequest: str(payload.userRequest, 'userRequest（明确不做本次随堂练习的原请求）'), reason: str(payload.reason, 'reason'), date: today };
    q.status = 'dismissed'; s.pendingQuizId = null;
    return { quizId: q.id, status: q.status, episodeStatus: latest(s).status };
  }
  if (command === 'waive') {
    const request = str(payload.userRequest, 'userRequest（明确跳过或暂缓的原请求）');
    const reason = str(payload.reason, 'reason');
    if (s.pendingQuizId) {
      requireValue(payload.cancelPendingQuiz === true, '已有待答测验；用户明确要求放弃该测验时才设置 cancelPendingQuiz');
      const q = s.quizzes.find(x => x.id === s.pendingQuizId);
      q.status = 'waived'; q.cancelUserRequest = request; s.pendingQuizId = null;
    }
    const e = latest(s), itemIds = payload.reviewItemIds ?? (payload.episode === true ? e?.focusIds ?? [] : []);
    requireValue(Array.isArray(itemIds) && itemIds.every(id => s.items[id]), 'reviewItemIds 无效');
    requireValue(payload.episode === true || itemIds.length > 0, '必须指定跳过当集或暂缓的词条范围');
    if (payload.episode === true) {
      requireValue(e && !['passed', 'waived'].includes(e.status), '当前集无需跳过');
      e.status = 'waived';
    }
    for (const id of itemIds) s.items[id].deferredOn = today;
    s.waivers.push({ date: today, userRequest: request, reason, episodeId: payload.episode ? e.id : null, reviewItemIds: itemIds });
    return { waived: Boolean(payload.episode), deferredItems: itemIds.length, readyForNext: blockers(s, today).length === 0 };
  }
  fail('未知写入命令');
}

const WRITE_COMMANDS = new Set(['init', 'configure', 'items', 'episode', 'teach', 'skip-teaching', 'quiz', 'answer', 'reassess', 'assessment-note', 'dismiss', 'waive', 'migrate']);
export async function execute(command, options = {}) {
  const { payload = {}, file, on, limit = 10, offset = 0 } = options;
  requireValue(Number.isInteger(limit) && limit > 0 && limit <= 30 && Number.isInteger(offset) && offset >= 0, '分页 limit 为 1–30，offset 为非负整数');
  if (command === 'count') return { wordCount: countWords(str(payload.text, 'text')) };
  requireValue(file, '必须显式提供 --file 档案路径');
  const target = path.resolve(file);
  if (!WRITE_COMMANDS.has(command)) {
    const s = await readState(target), today = validDate(on ?? dateInZone(s.profile.timezone));
    if (command === 'status') return summary(s, today, limit);
    if (command === 'show') return show(s, { ...options, offset, limit: options.limit ?? (options.section === 'next-questions' ? s.profile.quizBatchSize : limit) });
    fail('未知命令');
  }
  const eventId = str(payload.eventId, 'eventId（每个写入事件的唯一 ID）');
  requireValue(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/u.test(eventId), 'eventId 须为字母数字开头的 1–120 字符标识');
  const digest = hash(JSON.stringify({ command, payload }));
  await fs.mkdir(path.dirname(target), { recursive: true });
  let lock, temporary;
  try {
    try { lock = await fs.open(`${target}.lock`, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') fail('档案正在写入或遗留 .lock；核实进程结束后再处理锁，不并发覆盖'); throw error; }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    let s;
    if (command === 'init') {
      let exists = true;
      try { await fs.access(target); } catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
      if (exists) {
        const existing = await readState(target);
        if (Object.hasOwn(existing.events, eventId) && existing.events[eventId].digest === digest) return { ...existing.events[eventId].result, replayed: true };
        fail('档案已存在；init 不会覆盖旧课程');
      }
      requireValue(payload.bible && typeof payload.bible === 'object' && !Array.isArray(payload.bible), 'bible 必须为对象');
      str(payload.bible.premise, 'bible.premise');
      s = { schemaVersion: 2, revision: 0, courseId: str(payload.courseId, 'courseId'), title: str(payload.title, 'title'), profile: profileFrom(payload.profile), bible: payload.bible, learner: emptyLearner(), migrations: [], episodes: [], items: {}, quizzes: [], pendingQuizId: null, waivers: [], events: {}, createdAt: new Date().toISOString() };
    } else s = await readState(target);
    if (Object.hasOwn(s.events, eventId)) {
      requireValue(s.events[eventId].digest === digest, 'eventId 已用于不同内容，请为新事件使用新 ID');
      return { ...s.events[eventId].result, replayed: true };
    }
    const today = validDate(on ?? dateInZone(s.profile.timezone));
    const result = command === 'init' ? { courseId: s.courseId, title: s.title, status: 'ready' } : mutateState(command, s, payload, today);
    if (s._upgradeNeeded) s.migrations.push({ from: 1, to: 2, date: today, preservedLegacyTargets: true });
    delete s._upgradeNeeded;
    s.revision += 1; s.updatedAt = new Date().toISOString();
    const response = { revision: s.revision, ...result };
    s.events[eventId] = { digest, date: today, command, result: response };
    temporary = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(s, null, 2)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    if (command !== 'init') await fs.copyFile(target, `${target}.bak`);
    await fs.rename(temporary, target);
    temporary = undefined;
    return response;
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    if (lock) { await lock.close(); await fs.unlink(`${target}.lock`); }
  }
}

const HELP = `story_memory.mjs <command> --file <memory.json> [--payload <event.json>]
命令：init/configure/episode/teach/skip-teaching/quiz/answer/reassess/assessment-note/items/dismiss/waive/migrate/status/show/count
show: --section bible|learner|story|sentences|focus|items|quiz|next-questions|grading|quizzes|corrections|assessment-notes
设定 / 学习画像字段：--field timeline 或 skills.grammar；分页：--limit 1..30 --offset N
历史集：--episode E0001；历史题：--quiz T0001；字符串字段以 offset 字符位分页
count: --text-file <英文正文.txt>；所有写入 payload 必须包含唯一 eventId
写入前后保留原子替换与 .bak；读取 status 不会修改学习进度。`;
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['--help', '-h', 'help'].includes(command)) { process.stdout.write(`${HELP}\n`); return; }
  const flags = {};
  const allowed = new Set(['file', 'payload', 'text-file', 'section', 'limit', 'offset', 'episode', 'field', 'quiz']);
  for (let n = 0; n < args.length; n += 2) {
    const key = args[n].replace(/^--/u, '');
    requireValue(args[n].startsWith('--') && allowed.has(key) && args[n + 1] !== undefined, `无效参数：${args[n]}`);
    flags[key] = args[n + 1];
  }
  const payload = flags.payload ? JSON.parse((await fs.readFile(path.resolve(flags.payload), 'utf8')).replace(/^\uFEFF/u, '')) : {};
  if (flags['text-file']) payload.text = await fs.readFile(path.resolve(flags['text-file']), 'utf8');
  const result = await execute(command, { file: flags.file, payload, section: flags.section, episode: flags.episode, field: flags.field, quiz: flags.quiz, limit: flags.limit === undefined ? undefined : Number(flags.limit), offset: flags.offset === undefined ? 0 : Number(flags.offset) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { process.stderr.write(`错误：${error.message}\n`); process.exitCode = 1; });
}
