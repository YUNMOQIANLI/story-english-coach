import { REVIEW_INTERVALS, reviewPlan } from './learning_model.mjs';

const shift = (date, days) => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

// A workload scenario, not a forgetting model: one new lesson per day, all
// due recalls independently correct, one review slot per item, no real writes.
export function forecastReviewLoad(items, today, { newPerDay, budget, days = 60, firstDayBudget = budget }) {
  if (!Number.isInteger(newPerDay) || newPerDay < 0 || newPerDay > 100 || !Number.isInteger(budget) || budget < 1 || budget > 50 || !Number.isInteger(days) || days < 1 || days > 120) throw new Error('负担模拟的词数、日预算和天数无效');
  if (!Number.isInteger(firstDayBudget) || firstDayBudget < 0 || firstDayBudget > budget) throw new Error('今日剩余复习预算无效');
  const cards = items.map(item => ({ id: item.id, stage: item.stage, due: item.nextReviewOn, repair: item.needsRepair, requested: item.requestedReview, lastAdvancedOn: item.lastAdvancedOn, deferredOn: item.deferredOn }));
  let peakBacklog = 0, reviews = 0, endBacklog = 0;
  const checkpoints = [];
  for (let offset = 0; offset < days; offset++) {
    const day = shift(today, offset);
    const due = cards.filter(c => c.deferredOn !== day && (c.repair || c.requested || c.due <= day)).sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
    for (const card of due.slice(0, offset === 0 ? firstDayBudget : budget)) {
      const eligible = card.stage < 0 || card.due <= day || card.repair;
      if (eligible) {
        if (card.lastAdvancedOn !== day) card.stage = Math.min(card.stage + 1, REVIEW_INTERVALS.length - 1);
        card.stage = Math.max(0, card.stage);
        if (card.repair) card.stage = 0;
        card.due = shift(day, REVIEW_INTERVALS[card.stage]); card.lastAdvancedOn = day;
      }
      card.repair = false; card.requested = false; reviews++;
    }
    endBacklog = cards.filter(c => c.deferredOn !== day && (c.repair || c.requested || c.due <= day)).length;
    peakBacklog = Math.max(peakBacklog, endBacklog);
    for (let index = 0; index < newPerDay; index++) cards.push({ id: `projection-${offset}-${index}`, stage: 0, due: shift(day, 1), repair: false, requested: false, lastAdvancedOn: day });
    if ([7, 14, 30, days].includes(offset + 1)) checkpoints.push({ day: offset + 1, remainingDue: endBacklog });
  }
  return { newPerDay, days, reviewBudget: budget, firstDayBudget, endBacklog, peakBacklog, reviews, checkpoints };
}

export function vocabularyPlan(s, today) {
  const items = Object.values(s.items), budget = s.profile.reviewItemsPerDay;
  const firstDayBudget = reviewPlan({ ...s, quizzes: s.quizzes ?? [] }, today, []).remainingBudget;
  const baseline = forecastReviewLoad(items, today, { newPerDay: 0, budget, firstDayBudget });
  const configured = forecastReviewLoad(items, today, { newPerDay: s.profile.newItemsLimit, budget, firstDayBudget });
  let recommended = baseline;
  // The limit is a maximum, not an instruction to create that many fresh cards.
  for (let count = 1; count <= Math.min(s.profile.newItemsLimit, 5); count++) {
    const scenario = forecastReviewLoad(items, today, { newPerDay: count, budget, firstDayBudget });
    if (scenario.endBacklog <= baseline.endBacklog && scenario.peakBacklog <= Math.max(baseline.peakBacklog, budget)) recommended = scenario;
  }
  const old = items.filter(item => item.history.length > 0);
  const firstLessonNeedsNew = old.length === 0 && recommended.newPerDay === 0;
  const fixed = s.profile.newVocabularyPreference === 'fixed';
  return {
    policy: fixed ? 'fixed' : 'adaptive',
    focusUpperLimit: s.profile.newItemsLimit,
    recommendedNewFocusCount: fixed ? s.profile.newItemsLimit : firstLessonNeedsNew ? 1 : recommended.newPerDay,
    adaptiveSuggestion: recommended.newPerDay,
    preferExistingFocus: !fixed && old.length > 0 && recommended.newPerDay === 0,
    scheduledItems: items.length,
    configured, baseline, recommended,
    firstLessonNeedsNew: !fixed && firstLessonNeedsNew,
    assumption: '按每天完成一个片段、每项回忆独立正确、日复习预算不变估计未来六十天；不代表真实遗忘率、耗时或学习承诺。',
    reason: fixed ? '保留用户指定的新重点节奏；负担模拟用于讨论，不自动减少。' : recommended.newPerDay < s.profile.newItemsLimit ? '优先少量新重点与旧词迁移；故事词数和用户指定方向保留。新重点上限不要求每集用满。' : '按当前日复习预算估计可维持；继续依据实际错题和到期队列调整。',
  };
}
