// Local bookkeeping only: reaching a deadline does not prove a review happened.
const time = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const key = item => JSON.stringify([item.task_id, item.event_id ?? null, item.feedback_until ?? item.deadline ?? null]);
const list = round => round?.pending_queue ?? round?.pending_startup_feedback ?? [];

export function buildFeedbackReviews(result,{reviewed_at=new Date().toISOString(),max_age_seconds=180}={}) {
  const b=result?.brief, at=time(reviewed_at), captured=time(b?.at);
  if(result?.replayed||result?.status!=='live'||!result?.observation_id||at===null||captured===null
    ||!Number.isFinite(max_age_seconds)||max_age_seconds<=0||at<captured||at-captured>max_age_seconds*1000
    ||!b?.tasks?.coverage?.active||!b.tasks.coverage.paused||typeof b.evidence!=='string'||!b.evidence)return [];
  if(!['advertiser_id','primary_ad_id','room_id','session_started_at'].every(k=>b.binding?.[k]&&b.binding[k]===result.binding?.[k]))return [];
  const columns=b.tasks.columns, rows=new Map(), duplicate=new Set();
  if(!Array.isArray(columns)||new Set(columns).size!==columns.length||!['id','cost','orders','payment_roi'].every(k=>columns.includes(k)))return [];
  for(const pool of ['active','paused']) {
    if(!Array.isArray(b.tasks[pool]))return [];
    for(const row of b.tasks[pool]) {
      if(!Array.isArray(row)||row.length!==columns.length)return [];
      const task=Object.fromEntries(columns.map((k,i)=>[k,row[i]]));
      if(rows.has(task.id))duplicate.add(task.id);
      rows.set(task.id,{pool,...task});
    }
  }
  const unresolved=new Set((result.unresolved??[]).map(x=>x.task_id)), seen=new Set(), reviews=[];
  for(const event of b.pending??[]) {
    const task=rows.get(event.task_id), deadline=time(event.feedback_until??event.deadline);
    const eventKey=key(event);
    if(!event.event_id||seen.has(eventKey)||deadline===null||deadline>captured||duplicate.has(event.task_id)||unresolved.has(event.task_id)
      ||!task||!Number.isFinite(task.cost)||task.cost<0||!Number.isInteger(task.orders)||task.orders<0)continue;
    seen.add(eventKey);
    reviews.push({task_id:event.task_id,event_id:event.event_id,reviewed_at,evidence:b.evidence,
      result:JSON.stringify({kind:'observed_startup_feedback',sampled_at:b.at,pool:task.pool,cost:task.cost,orders:task.orders,
        payment_roi:Number.isFinite(task.payment_roi)?task.payment_roi:null}),
      feedback_until:event.feedback_until??event.deadline});
  }
  return reviews;
}

export function reconcileFeedback(previous, current, now = current.captured_at) {
  const pending = new Map();
  for (const item of [...list(previous), ...list(current)]) pending.set(key(item), { ...item });
  const completed = new Map((previous?.completed_startup_feedback ?? []).map(item => [key(item), item]));
  // A validated completion is terminal for this event, even if a stale adapter
  // resends its old pending entry. A new action must have a different event ID.
  for (const id of completed.keys()) pending.delete(id);
  const issues = [];
  const reviewLimit = time(current.finalized_at ?? now);
  for (const item of current.completed_startup_feedback ?? []) {
    const id = key(item), prior = completed.get(id);
    if (prior && !pending.has(id)) continue;
    const reviewed = time(item.reviewed_at);
    if (!pending.has(id) || reviewed === null || reviewLimit === null || reviewed > reviewLimit
        || reviewed < time(previous?.captured_at)
        || typeof item.result !== 'string' || !item.result.trim()
        || typeof item.evidence !== 'string' || !item.evidence.trim()) {
      issues.push({ code: 'feedback_review_unverified', task_id: item.task_id });
      continue;
    }
    completed.set(id, { ...pending.get(id), ...item });
    pending.delete(id);
  }
  return { pending: [...pending.values()].map(item => {
    const deadline = time(item.feedback_until ?? item.deadline), at = time(now);
    return { ...item, due: deadline !== null && at !== null ? deadline <= at : null,
      overdue_seconds: deadline !== null && at !== null ? Math.max(0, (at - deadline) / 1000) : null };
  }), completed: [...completed.values()], issues };
}
