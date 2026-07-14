const cron = require('node-cron');
const db = require('./db');

// Safety net: after a scheduled class ends, mark enrolled students with no
// attendance record for the day as absent. The frontend also triggers
// /attendance/auto-finalize when a session ends; this covers missed cases.
function startAutoAbsentJob() {
  cron.schedule('*/5 * * * *', async () => {
    try {
      const tableCheck = await db.query(`SELECT to_regclass('public.class_schedules') IS NOT NULL AS exists`);
      if (!tableCheck.rows[0].exists) {
        return;
      }

      // Schedules that apply today (one-off by date, or weekly by day_of_week),
      // have ended, and are not yet finalized
      const schedules = await db.query(`
        SELECT id, class_id, scheduled_date, start_time, end_time
        FROM class_schedules
        WHERE is_completed = false
          AND COALESCE(is_active, true) = true
          AND (scheduled_date = CURRENT_DATE
               OR (scheduled_date IS NULL AND day_of_week = EXTRACT(DOW FROM CURRENT_DATE)::int))
          AND end_time < CURRENT_TIME
      `);

      if (!schedules.rows.length) {
        return;
      }
      console.log(`🕒 autoAbsentJob: finalizing ${schedules.rows.length} ended schedule(s)`);

      for (const sched of schedules.rows) {
        const sessionDate = sched.scheduled_date
          ? new Date(sched.scheduled_date).toISOString().slice(0, 10)
          : new Date().toISOString().slice(0, 10);

        // Enrolled students with no attendance row for this class today (any session scoping)
        const missing = await db.query(`
          SELECT e.student_id
          FROM enrollments e
          WHERE e.class_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM attendance a
              WHERE a.class_id = e.class_id
                AND a.student_id = e.student_id
                AND a.session_date = $2
            )
        `, [sched.class_id, sessionDate]);

        for (const row of missing.rows) {
          await db.query(`
            INSERT INTO attendance (class_id, student_id, session_date, present, method, confidence)
            VALUES ($1, $2, $3, false, 'auto_absent', 0.0)
            ON CONFLICT (class_id, student_id, session_date) WHERE session_id IS NULL
            DO NOTHING
          `, [sched.class_id, row.student_id, sessionDate]);
        }

        // Only mark one-off schedules completed; weekly ones repeat each week
        if (sched.scheduled_date) {
          await db.query('UPDATE class_schedules SET is_completed = true WHERE id = $1', [sched.id]);
        }

        if (missing.rows.length) {
          console.log(`autoAbsentJob: marked ${missing.rows.length} absent for class ${sched.class_id} (schedule ${sched.id})`);
        }
      }
    } catch (err) {
      console.error('autoAbsentJob error:', err.message);
    }
  });
  console.log('🕒 Auto-absent job scheduled (every 5 minutes)');
}

module.exports = { startAutoAbsentJob };
