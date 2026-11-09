import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export class MhpLearningError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export type MhpLearningTier = 'full' | 'desk' | 'none';
export interface MhpCourseLessonOutline { key: string; position: number; slug: string; title: string; minutes: number | null; task: string | null }
export interface MhpCourseModuleOutline {
  number: string; slug: string; title: string; promise: string | null; door: string | null; level: string | null;
  open: boolean; lessons: MhpCourseLessonOutline[];
}
export interface MhpLessonProgress { taskDone: boolean; completed: boolean; notes: string }
export interface MhpCourseOutline {
  tier: MhpLearningTier; isAdmin: boolean; modules: MhpCourseModuleOutline[]; progress: Record<string, MhpLessonProgress>;
}
export interface MhpCourseBundle {
  modules: { number: number; slug: string; title: string; promise: string | null; door: string | null; level: string | null;
    overview: string; sources: string;
    lessons: { number: number; slug: string; title: string; minutes: number | null; task: string | null; body: string }[] }[];
}

const hash = (token: string): Buffer => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new MhpLearningError(403, 'Sign in to Martin Howard Property again.');
  return createHash('sha256').update(token).digest();
};
function failure(error: unknown, fallback: string): never {
  if (error instanceof MhpLearningError) throw error;
  const code = (error as { code?: string })?.code;
  if (code === '42501') throw new MhpLearningError(403, 'This lesson is part of the full course.');
  if (code === '22023' || code === '23514' || code === '22P02' || code === '23502') throw new MhpLearningError(400, 'Check the details and try again.');
  throw new MhpLearningError(503, fallback);
}
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Validates an uploaded course bundle before it reaches the database. */
export function parseMhpCourseBundle(raw: string): MhpCourseBundle {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { throw new MhpLearningError(400, 'That file is not a course bundle.'); }
  const bad = (): never => { throw new MhpLearningError(400, 'That file is not a valid course bundle.'); };
  const text = (value: unknown, max: number, optional = false): string | null => {
    if ((value === null || value === undefined || value === '') && optional) return null;
    if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) return bad();
    return value;
  };
  const modules = (data as { modules?: unknown })?.modules;
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > 60) bad();
  const seen = new Set<number>();
  return {
    modules: (modules as Record<string, unknown>[]).map(m => {
      if (!m || typeof m !== 'object' || !Number.isInteger(m.number) || (m.number as number) < 0 || (m.number as number) > 99 || seen.has(m.number as number)) bad();
      seen.add(m.number as number);
      if (!Array.isArray(m.lessons) || m.lessons.length > 40) bad();
      const lessonNumbers = new Set<number>();
      return {
        number: m.number as number, slug: text(m.slug, 80)!, title: text(m.title, 200)!, promise: text(m.promise, 2000, true),
        door: text(m.door, 40, true), level: text(m.level, 2, true), overview: text(m.overview ?? '', 200_000)!, sources: text(m.sources ?? '', 200_000)!,
        lessons: (m.lessons as Record<string, unknown>[]).map(l => {
          if (!l || typeof l !== 'object' || !Number.isInteger(l.number) || (l.number as number) < 1 || (l.number as number) > 99 || lessonNumbers.has(l.number as number)) bad();
          lessonNumbers.add(l.number as number);
          if (l.minutes !== null && l.minutes !== undefined && (!Number.isInteger(l.minutes) || (l.minutes as number) < 1 || (l.minutes as number) > 240)) bad();
          return { number: l.number as number, slug: text(l.slug, 80)!, title: text(l.title, 200)!, minutes: (l.minutes as number | null) ?? null,
            task: text(l.task, 2000, true), body: text(l.body, 300_000)! };
        }),
      };
    }),
  };
}

export class PgMhpLearningService {
  constructor(private readonly readPool: Pick<Pool, 'query'>, private readonly commandPool: Pick<Pool, 'query'>) {}

  async outline(token: string): Promise<MhpCourseOutline> {
    try {
      const result = await this.readPool.query<{ outline: MhpCourseOutline }>('SELECT app_private.mhp_course_outline($1) AS outline', [hash(token)]);
      const outline = result.rows[0]?.outline;
      if (!outline || !Array.isArray(outline.modules) || !['full', 'desk', 'none'].includes(outline.tier)) throw new MhpLearningError(503, 'The training centre could not load.');
      return outline;
    } catch (error) { failure(error, 'The training centre could not load.'); }
  }

  async content(token: string, key: string): Promise<{ overview?: string; sources?: string; body?: string } | null> {
    if (!/^[0-9]{2}(\/[0-9]{2})?$/.test(key)) throw new MhpLearningError(404, 'Lesson not found.');
    try {
      const result = await this.readPool.query<{ content: { overview?: string; sources?: string; body?: string } | null }>(
        'SELECT app_private.mhp_course_content($1,$2) AS content', [hash(token), key]);
      return result.rows[0]?.content ?? null;
    } catch (error) { failure(error, 'This lesson could not load.'); }
  }

  async saveProgress(token: string, key: string, form: Record<string, string>): Promise<void> {
    if (!/^[0-9]{2}\/[0-9]{2}$/.test(key)) throw new MhpLearningError(404, 'Lesson not found.');
    const complete = form.complete === 'yes';
    const taskDone = complete || form.taskDone === 'yes';
    const notes = (form.notes ?? '').replace(/\r\n/g, '\n');
    if (notes.length > 10_000 || CONTROL.test(notes)) throw new MhpLearningError(400, 'Keep your notes under 10,000 characters.');
    try {
      await this.commandPool.query('SELECT app_private.mhp_save_lesson_progress($1,$2,$3,$4,$5)', [hash(token), key, taskDone, complete, notes.trim() || null]);
    } catch (error) { failure(error, 'Your progress could not be saved. Please try again.'); }
  }

  async importCourse(token: string, bundle: MhpCourseBundle): Promise<{ modules: number; lessons: number }> {
    try {
      const result = await this.commandPool.query<{ counts: { modules: number; lessons: number } }>(
        'SELECT app_private.mhp_import_course($1,$2::jsonb) AS counts', [hash(token), JSON.stringify(bundle)]);
      const counts = result.rows[0]?.counts;
      if (!counts) throw new MhpLearningError(503, 'The course upload was not confirmed.');
      return counts;
    } catch (error) {
      if ((error as { code?: string })?.code === '42501') throw new MhpLearningError(403, 'Owner access is required to load the course.');
      failure(error, 'The course upload was not confirmed.');
    }
  }
}
