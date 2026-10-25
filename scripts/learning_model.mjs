export const ITEM_DIMENSIONS = ['meaning', 'usage', 'production'];
export const REVIEW_INTERVALS = Object.freeze([1, 3, 7, 14, 30, 60]);
const SKILLS = ['vocabulary', 'grammar', 'expression'];
export const gradeFor = mark => mark.assistance === 'answer_seen' || mark.score === 0 ? 0 : mark.assistance === 'hint' || mark.score === 1 ? 1 : 2;
export const gradeForTarget = (mark, target) => {
  const detail = mark.targetMarks?.[target];
  // Global assistance still applies; a local mark can add assistance, never hide it.
  return detail ? Math.min(gradeFor({ ...detail, assistance: mark.assistance }), gradeFor(detail)) : gradeFor(mark);
};
export const parseItemTarget = target => {
  const match = /^item:(V[0-9a-f]{16})(?::(meaning|usage|production))?$/u.exec(target);
  return match ? { id: match[1], dimension: match[2] ?? null } : null;
};
export function emptyLearner() {
  return { skills: Object.fromEntries(SKILLS.map(k => [k, { attempts: 0, independentCorrect: 0, window: [] }])), completedLessonQuizzes: 0 };
}
export function ensureExtensions(s) {
  s.learner ??= emptyLearner();
  s.migrations ??= [];
  for (const item of Object.values(s.items)) {
    item.mastery ??= Object.fromEntries(ITEM_DIMENSIONS.map(d => [d, null]));
    item.exposures ??= [];
  }
  for (const q of s.quizzes) {
    q.appliedItemIds ??= q.status === 'graded' ? [...new Set(q.questions.flatMap(x => x.targets.map(parseItemTarget).filter(Boolean).map(t => t.id)))] : [];
  }
  return s;
}
export function requiredTargets(focusIds, goals) {
  const defaults = { comprehension: 'comprehension', grammar: 'structure', expression: 'transfer' };
  const targets = Object.entries(defaults).flatMap(([kind, fallback]) => {
    const selected = goals.filter(g => g.kind === kind);
    return selected.length ? selected.map(g => `goal:${kind}:${g.id}`) : [fallback];
  });
  return [...targets, ...focusIds.flatMap(id => ITEM_DIMENSIONS.map(d => `item:${id}:${d}`))];
}
function skillsFor(question) {
  const skills = new Set();
  for (const target of question.targets) {
    const item = parseItemTarget(target);
    if (item) skills.add(item.dimension === 'production' ? 'expression' : 'vocabulary');
    else if (target === 'structure' || target.startsWith('goal:grammar:')) skills.add('grammar');
    else if (target === 'transfer' || target.startsWith('goal:expression:')) skills.add('expression');
  }
  return skills;
}
export function recordQuizObservations(s, quiz) {
  for (const question of quiz.questions) {
    const mark = quiz.marks[question.id];
    for (const skill of skillsFor(question)) {
      const related = question.targets.filter(target => skillsFor({ targets: [target] }).has(skill));
      const record = s.learner.skills[skill], independent = related.every(target => gradeForTarget(mark, target) === 2);
      record.attempts += 1; record.independentCorrect += Number(independent);
      record.window.push({ quizId: quiz.id, questionId: question.id, date: mark.date, independent, scope: quiz.scope });
      record.window = record.window.slice(-20);
    }
  }
  if (quiz.scope === 'lesson') s.learner.completedLessonQuizzes += 1;
}
export function learningPlan(s) {
  const metrics = Object.fromEntries(SKILLS.map(k => {
    const data = s.learner.skills[k], window = data.window;
    return [k, { attempts: data.attempts, recentSamples: window.length, independentAccuracy: window.length ? Number((window.filter(x => x.independent).length / window.length).toFixed(3)) : null }];
  }));
  const completedLessons = s.episodes.filter(e => e.status === 'passed').length;
  const enough = completedLessons >= 2 && SKILLS.every(k => metrics[k].recentSamples >= 5);
  const weakSkills = SKILLS.filter(k => metrics[k].recentSamples >= 5 && metrics[k].independentAccuracy < 0.6);
  const seenEpisodes = new Set();
  const recentLessons = s.quizzes.filter(q => q.scope === 'lesson' && q.status === 'graded').reverse().filter(q => {
    if (seenEpisodes.has(q.episodeId)) return false;
    seenEpisodes.add(q.episodeId); return true;
  }).slice(0, 2);
  let direction = 'maintain';
  if (s.profile.difficultyPreference !== 'fixed' && enough) {
    if (weakSkills.length) direction = 'simplify';
    else if (SKILLS.every(k => metrics[k].independentAccuracy >= 0.9) && recentLessons.every(q => q.result?.independentFullMarks)) direction = 'challenge';
  }
  return { metrics, completedLessons, enoughEvidence: enough, direction, weakSkills, recommendedFocusLimit: direction === 'simplify' ? Math.max(1, Math.floor(s.profile.newItemsLimit * 0.7)) : s.profile.newItemsLimit, teachingBatchSize: s.profile.teachingBatchSize, dailyMinutes: s.profile.dailyMinutes, level: s.profile.level, levelProvisional: s.profile.levelProvisional, reason: !enough ? '样本不足，保持暂定难度，不推断正式等级。' : direction === 'simplify' ? '优先减少新知识并补讲较弱能力。' : direction === 'challenge' ? '连续独立正确，可只提高一种句式的复杂度。' : '维持当前难度，依据具体错题补讲。' };
}
export function exposureStats(item) {
  const episodes = new Set(item.sources.filter(x => ['episode', 'exposure'].includes(x.type)).map(x => x.episodeId));
  return { episodeCount: episodes.size, contextCount: new Set(item.exposures.map(x => x.contextTag)).size, lastEpisodeId: [...episodes].at(-1) ?? null };
}
export function recyclePlan(s, today, limit = 5) {
  return Object.values(s.items).filter(i => i.history.length > 0).map(i => {
    const stats = exposureStats(i), due = i.nextReviewOn <= today, weak = ITEM_DIMENSIONS.filter(d => i.mastery[d]?.grade !== 2);
    return { id: i.id, term: i.term, meaning: i.meaning.slice(0, 200), due, weakDimensions: weak, ...stats, recommendedDimension: weak[0] ?? ITEM_DIMENSIONS[(i.stage + 1) % ITEM_DIMENSIONS.length], priority: (i.needsRepair ? 1000 : 0) + (due ? 500 : 0) + weak.length * 50 + Math.max(0, 3 - stats.episodeCount) * 10 };
  }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)).slice(0, limit);
}

export function reviewPlan(s, today, due) {
  const quizzes = new Map(s.quizzes.map(q => [q.id, q]));
  const reviewsToday = item => item.history.filter(h => h.date === today && quizzes.get(h.quizId)?.scope === 'review');
  const lastToday = item => reviewsToday(item).at(-1);
  const completed = Object.values(s.items).filter(i => lastToday(i)?.grade === 2 && reviewsToday(i).some(h => h.grade === 2 && (h.wasDue ?? h.before.nextReviewOn <= today))).length;
  const budget = s.profile.reviewItemsPerDay;
  const remaining = Math.max(0, budget - completed);
  const repairs = due.filter(i => i.needsRepair && lastToday(i) && lastToday(i).grade < 2);
  const prioritized = [...repairs, ...due.filter(i => !repairs.includes(i))];
  const capacity = s.profile.reviewPolicy === 'strict' ? budget : Math.max(remaining, Math.min(budget, repairs.length));
  return { policy: s.profile.reviewPolicy, budget, completedToday: completed, remainingBudget: remaining, dueCount: due.length, requiredCount: s.profile.reviewPolicy === 'strict' ? due.length : Math.min(due.length, remaining), repairCount: repairs.length, selectedIds: prioritized.slice(0, capacity).map(i => i.id), backlogCount: Math.max(0, due.length - capacity) };
}
