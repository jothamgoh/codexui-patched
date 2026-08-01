import type { AutomationDraft, AutomationTask } from '../types/automations'
import { DEFAULT_AUTOMATION_TIME_ZONE } from '../types/automations'

type AutomationSchedule = Partial<Pick<
  AutomationDraft | AutomationTask,
  'scheduleType' | 'rrule' | 'runAtIso' | 'timezone'
>>
  & Partial<Pick<AutomationTask, 'nextRunAtIso' | 'lastRunAtIso'>>

const weekdayNames: Record<string, string> = {
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
  SU: 'Sunday',
}

function readInterval(rule: string): number {
  return Math.max(1, Number(/(?:^|;)INTERVAL=(\d+)/u.exec(rule)?.[1] ?? 1) || 1)
}

function formatRuleTime(rule: string): string {
  const hour = Number(/(?:^|;)BYHOUR=(\d+)/u.exec(rule)?.[1] ?? 9)
  const minute = Number(/(?:^|;)BYMINUTE=(\d+)/u.exec(rule)?.[1] ?? 0)
  return new Intl.DateTimeFormat(undefined, {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(Date.UTC(2026, 0, 1, hour, minute)))
}

function readWeekdays(rule: string): string[] {
  const values = /(?:^|;)BYDAY=([^;]+)/u.exec(rule)?.[1]?.split(',') ?? []
  return values.map((value) => weekdayNames[value]).filter(Boolean)
}

function formatWeekdays(days: string[]): string {
  if (days.length === 0) return ''
  if (days.length === 1) return days[0] ?? ''
  if (days.length === 2) return `${days[0]} and ${days[1]}`
  return `${days.slice(0, -1).join(', ')}, and ${days.at(-1)}`
}

export function isOneTimeAutomation(schedule: AutomationSchedule): boolean {
  return schedule.scheduleType === 'once'
    || /(?:^|;)COUNT=1(?:;|$)/iu.test(schedule.rrule || '')
}

export function formatAutomationDateTime(
  value: string,
  timezone = DEFAULT_AUTOMATION_TIME_ZONE,
  options: { includeYear?: boolean } = {},
): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return 'Not scheduled'
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone || DEFAULT_AUTOMATION_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    ...(options.includeYear === false ? {} : { year: 'numeric' as const }),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date)
}

export function describeAutomationFrequency(schedule: AutomationSchedule): string {
  if (isOneTimeAutomation(schedule)) {
    const runAtIso = schedule.runAtIso || schedule.nextRunAtIso || schedule.lastRunAtIso
    return runAtIso
      ? `Once on ${formatAutomationDateTime(runAtIso, schedule.timezone)}`
      : 'Once (date not set)'
  }

  const rule = (schedule.rrule || '').replace(/^RRULE:/iu, '').toUpperCase()
  if (!rule) return 'Custom schedule'
  const interval = readInterval(rule)
  const time = formatRuleTime(rule)
  if (rule.startsWith('FREQ=MINUTELY')) {
    return interval === 1 ? 'Every minute' : `Every ${interval} minutes`
  }
  if (rule.startsWith('FREQ=HOURLY')) {
    return interval === 1 ? 'Every hour' : `Every ${interval} hours`
  }
  if (rule.startsWith('FREQ=DAILY')) {
    return interval === 1 ? `Every day at ${time}` : `Every ${interval} days at ${time}`
  }
  if (rule.startsWith('FREQ=WEEKLY')) {
    const days = readWeekdays(rule)
    if (days.join(',') === 'Monday,Tuesday,Wednesday,Thursday,Friday') {
      return `Every weekday at ${time}`
    }
    const dayLabel = formatWeekdays(days)
    if (interval === 1 && dayLabel) return `Every ${dayLabel} at ${time}`
    if (interval === 1) return `Every week at ${time}`
    return dayLabel
      ? `Every ${interval} weeks on ${dayLabel} at ${time}`
      : `Every ${interval} weeks at ${time}`
  }
  if (rule.startsWith('FREQ=MONTHLY')) {
    return interval === 1 ? `Every month at ${time}` : `Every ${interval} months at ${time}`
  }
  if (rule.startsWith('FREQ=YEARLY')) {
    return interval === 1 ? `Every year at ${time}` : `Every ${interval} years at ${time}`
  }
  return 'Custom recurring schedule'
}

export function describeAutomationCadence(schedule: AutomationSchedule): string {
  if (isOneTimeAutomation(schedule)) return 'Runs once'
  const rule = (schedule.rrule || '').replace(/^RRULE:/iu, '').toUpperCase()
  const interval = readInterval(rule)
  if (rule.startsWith('FREQ=MINUTELY')) return interval === 1 ? 'Repeats every minute' : `Repeats every ${interval} min`
  if (rule.startsWith('FREQ=HOURLY')) return interval === 1 ? 'Repeats hourly' : `Repeats every ${interval} hours`
  if (rule.includes('BYDAY=MO,TU,WE,TH,FR')) return 'Repeats weekdays'
  if (rule.startsWith('FREQ=DAILY')) return interval === 1 ? 'Repeats daily' : `Repeats every ${interval} days`
  if (rule.startsWith('FREQ=WEEKLY')) return interval === 1 ? 'Repeats weekly' : `Repeats every ${interval} weeks`
  if (rule.startsWith('FREQ=MONTHLY')) return interval === 1 ? 'Repeats monthly' : `Repeats every ${interval} months`
  if (rule.startsWith('FREQ=YEARLY')) return interval === 1 ? 'Repeats yearly' : `Repeats every ${interval} years`
  return 'Repeating schedule'
}

export function automationStatusLabel(task: AutomationTask): string {
  if (isOneTimeAutomation(task) && task.lastRunAtIso && !task.nextRunAtIso) return 'Completed'
  return task.status === 'ACTIVE' ? 'Active' : 'Paused'
}
