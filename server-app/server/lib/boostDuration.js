'use strict';

// The platform task-centre editor displays (endTime - startTime) / 3600 and
// submits startTime + hours * 3600 as Schedule.EndTime (2026-09-30 source audit).
// deliverySeconds is elapsed delivery, and an ambiguous Duration is not a
// total-duration readback. Never copy a requested value into the observation.
function positiveInteger(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function readBoostDuration(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const start = positiveInteger(raw.startTime);
  const end = positiveInteger(raw.endTime);
  const explicit = positiveInteger(raw.duration_seconds);
  const scheduled = start != null && end != null && end > start ? end - start : null;
  const invalidSchedule = (raw.startTime != null || raw.endTime != null) && scheduled == null;
  const conflict = explicit != null && scheduled != null && explicit !== scheduled;
  const seconds = conflict || invalidSchedule ? null : scheduled ?? explicit;
  return {
    duration_seconds: seconds,
    duration_unit: seconds == null ? 'unknown' : 'seconds',
    duration_source: seconds == null ? null : scheduled != null ? 'upstream.endTime-startTime' : 'upstream.duration_seconds',
    duration_reason: conflict ? 'duration_fields_conflict' : invalidSchedule ? 'duration_schedule_invalid' : seconds == null ? 'duration_unavailable' : null,
  };
}

module.exports = { readBoostDuration, positiveInteger };
