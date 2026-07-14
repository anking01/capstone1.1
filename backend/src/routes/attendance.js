// =======================================
// 📘 Attendance Routes (Enhanced)
// =======================================

const express = require('express');
const router = express.Router();
const db = require('../db');
const { v4: uuidv4 } = require('uuid');
const { manualFinalizeAttendance, finalizeAttendanceSession } = require('../services/attendanceFinalizer');

// Safe UPSERT helper function with fallback
async function safeUpsertAttendance(query, params, conflictColumns) {
  try {
    // Try INSERT with ON CONFLICT first
    const result = await db.query(query, params);
    return result;
  } catch (error) {
    if (error.message.includes('there is no unique or exclusion constraint matching the ON CONFLICT specification')) {
      console.log('ON CONFLICT failed, using fallback UPDATE then INSERT logic');
      
      // Extract values from params based on call type
      if (params.length === 7) {
        // Session-based call: [class_id, student_id, session_id, session_date, present, method, confidence]
        var [class_id, student_id, session_id, session_date, present, method, confidence] = params;
      } else {
        // Date-based call: [class_id, student_id, session_date, present, method, confidence, session_id]
        var [class_id, student_id, session_date, present, method, confidence, session_id] = params;
      }
      
      // Try UPDATE first
      const updateResult = await db.query(`
        UPDATE attendance 
        SET present = $1, method = $2, confidence = $3, recorded_at = NOW()
        WHERE class_id = $4 AND student_id = $5 AND session_date = $6 AND session_id IS ${session_id ? 'NOT NULL' : 'NULL'} ${session_id ? 'AND session_id = $7' : ''}
        RETURNING *
      `, [present, method, confidence, class_id, student_id, session_date, ...(session_id ? [session_id] : [])]);
      
      // If no rows were updated, try INSERT
      if (updateResult.rows.length === 0) {
        const insertResult = await db.query(`
          INSERT INTO attendance (class_id, student_id, session_date, session_id, present, method, confidence, recorded_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          RETURNING *
        `, [class_id, student_id, session_date, session_id, present, method, confidence]);
        return insertResult;
      }
      
      return updateResult;
    }
    throw error;
  }
}

// =======================================
// 1️⃣ Record Attendance
// =======================================
router.post('/record', async (req, res) => {
  console.log("📝 Attendance record route hit:", req.originalUrl);
  try {
    const { class_id, student_id, session_date, session_id, method, confidence, present } = req.body;

    console.log('📥 ATTENDANCE REQUEST:', { 
      class_id, 
      student_id, 
      session_date, 
      session_id,
      method, 
      confidence,
      present,
      bodyKeys: Object.keys(req.body)
    });

    if (!class_id || !student_id || (!session_date && !session_id)) {
      console.log('❌ MISSING REQUIRED FIELDS:', { class_id, student_id, session_date, session_id });
      return res.status(400).json({ error: 'class_id, student_id, and either session_date or session_id are required' });
    }

    console.log('📥 Received:', { class_id, student_id, session_date, session_id });

    // Resolve student to numeric database ID.
    // Accepts: roll/registration number ("12218198", "STU001") or the numeric DB id.
    let numericStudentId = null;
    const studentIdStr = String(student_id).trim();

    // 1) Exact match on students.student_id (covers roll numbers and STU codes)
    let lookup = await db.query('SELECT id FROM students WHERE student_id = $1', [studentIdStr]);
    if (lookup.rows.length > 0) {
      numericStudentId = lookup.rows[0].id;
    } else if (/^\d+$/.test(studentIdStr)) {
      // 2) Numeric: treat as database ID
      lookup = await db.query('SELECT id FROM students WHERE id = $1', [parseInt(studentIdStr, 10)]);
      if (lookup.rows.length > 0) {
        numericStudentId = lookup.rows[0].id;
      } else {
        // 3) Legacy fallback: STU-prefixed code
        lookup = await db.query('SELECT id FROM students WHERE student_id = $1', ['STU' + studentIdStr]);
        if (lookup.rows.length > 0) {
          numericStudentId = lookup.rows[0].id;
        }
      }
    }

    if (numericStudentId === null) {
      return res.status(404).json({ error: `Student ${studentIdStr} not found` });
    }
    console.log(`🎯 Resolved student ${studentIdStr} → ID: ${numericStudentId}`);

    // Check enrollment
    const enrolled = await db.query(
      'SELECT * FROM enrollments WHERE class_id = $1 AND student_id = $2',
      [class_id, numericStudentId]
    );

    if (enrolled.rows.length === 0) {
      return res.status(400).json({ error: 'Student not enrolled in this class' });
    }

    // Generate unique session_id if not provided to prevent cross-week duplication
    const uniqueSessionId = session_id || null;
    
    // Mark attendance (session-scoped when session_id is provided).
    // This fixes cross-session bleed on same calendar date.
    let result;
    const targetDate = session_date || new Date().toISOString().slice(0, 10);
    // Normalize method to values allowed by the attendance_method_check constraint
    const METHOD_MAP = {
      face: 'face', face_recognition: 'face', facial_recognition: 'face',
      qr: 'qr', qr_code: 'qr',
      manual: 'manual',
      auto: 'auto_absent', auto_absent: 'auto_absent'
    };
    const attendanceMethod = METHOD_MAP[String(method || 'face').toLowerCase()] || 'manual';
    const attendanceConfidence = confidence || 1.0;
    const isPresent = present !== undefined ? present : true; // Default to true if not specified
    
    // Prevent duplicate attendance records for same student, session, and status
    let duplicateCheck;
    if (uniqueSessionId) {
      // Session-based duplicate check
      duplicateCheck = await db.query(`
        SELECT id, present, method, recorded_at FROM attendance 
        WHERE student_id = $1 AND class_id = $2 AND session_id = $3
        ORDER BY recorded_at DESC
        LIMIT 5
      `, [numericStudentId, class_id, uniqueSessionId]);
    } else {
      // Date-based duplicate check (fallback)
      duplicateCheck = await db.query(`
        SELECT id, present, method, recorded_at FROM attendance 
        WHERE student_id = $1 AND class_id = $2 AND session_date = $3 AND session_id IS NULL
        ORDER BY recorded_at DESC
        LIMIT 5
      `, [numericStudentId, class_id, targetDate]);
    }
    
    // Check for existing attendance with same status in the same session
    const hasExistingStatus = duplicateCheck.rows.some(record => 
      record.present === isPresent
    );
    
    if (hasExistingStatus) {
      console.log(`⚠️ Duplicate attendance prevented for student ${numericStudentId} - already marked as ${isPresent ? 'present' : 'absent'} for session ${uniqueSessionId || targetDate}`);
      return res.status(409).json({ 
        error: 'Duplicate attendance record',
        message: `Student already marked as ${isPresent ? 'present' : 'absent'} for this session`
      });
    }
    
    console.log('🎯 Attendance Details:', {
      class_id,
      numericStudentId,
      uniqueSessionId,
      targetDate,
      attendanceMethod,
      attendanceConfidence,
      isPresent
    });
    
    if (uniqueSessionId) {
      // Use safe UPSERT for session-based attendance
      result = await safeUpsertAttendance(`
        INSERT INTO attendance (class_id, student_id, session_id, session_date, present, method, confidence)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (class_id, student_id, session_date)
        DO UPDATE SET present = EXCLUDED.present, method = EXCLUDED.method,
                      confidence = GREATEST(attendance.confidence, EXCLUDED.confidence),
                      session_id = EXCLUDED.session_id,
                      recorded_at = now()
        RETURNING *;
      `, [class_id, numericStudentId, uniqueSessionId, targetDate, isPresent, attendanceMethod, attendanceConfidence]);
    } else {
      // Use safe UPSERT for date-based attendance
      result = await safeUpsertAttendance(`
        INSERT INTO attendance (class_id, student_id, session_date, present, method, confidence)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (class_id, student_id, session_date)
        WHERE session_id IS NULL
        DO UPDATE SET present = $4, method = EXCLUDED.method, 
                      confidence = GREATEST(attendance.confidence, EXCLUDED.confidence),
                      recorded_at = now()
        RETURNING *;
      `, [class_id, numericStudentId, targetDate, isPresent, attendanceMethod, attendanceConfidence]);
    }

    console.log(`✅ Marked: ${student_id} (ID: ${numericStudentId}) as ${isPresent ? 'PRESENT' : 'ABSENT'}`);
    res.json({ success: true, attendance: result.rows[0] });

  } catch (error) {
    console.error('❌ Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Compatibility endpoint expected by deployments/scripts
router.post('/mark', async (req, res) => {
  try {
    const { user_id, course_id, session_date, method, confidence } = req.body;

    if (!user_id || !course_id) {
      return res.status(400).json({ error: 'user_id and course_id are required' });
    }

    const studentLookup = await db.query(
      'SELECT id, student_id, name FROM students WHERE lms_user_id = $1 OR id = $1 LIMIT 1',
      [user_id]
    );
    const classLookup = await db.query(
      'SELECT id, code, name FROM classes WHERE lms_course_id = $1 OR id = $1 LIMIT 1',
      [course_id]
    );

    if (studentLookup.rows.length === 0) {
      return res.status(404).json({ error: 'Student mapping not found for user_id' });
    }
    if (classLookup.rows.length === 0) {
      return res.status(404).json({ error: 'Class mapping not found for course_id' });
    }

    const student = studentLookup.rows[0];
    const cls = classLookup.rows[0];
    const targetDate = session_date || new Date().toISOString().slice(0, 10);

    const result = await db.query(`
      INSERT INTO attendance (class_id, student_id, session_date, present, method, confidence)
      VALUES ($1, $2, $3, true, $4, $5)
      ON CONFLICT (class_id, student_id, session_date)
      WHERE session_id IS NULL
      DO UPDATE SET
        present = true,
        method = EXCLUDED.method,
        confidence = GREATEST(attendance.confidence, EXCLUDED.confidence),
        recorded_at = now()
      RETURNING *;
    `, [cls.id, student.id, targetDate, method || 'manual', confidence || 1.0]);

    res.json({
      success: true,
      attendance: result.rows[0],
      mapped: {
        class_id: cls.id,
        student_id: student.id,
        class_name: cls.name,
        student_name: student.name
      }
    });
  } catch (error) {
    console.error('Error in /attendance/mark:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/student/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Support both STU001 format and numeric registration numbers
    let numericStudentId;
    if (typeof id === 'string' && isNaN(id)) {
      // Handle STU001 format - look up by student_id field
      const lookup = await db.query('SELECT id FROM students WHERE student_id = $1', [id]);
      if (lookup.rows.length === 0) {
        return res.status(404).json({ error: `Student ${id} not found` });
      }
      numericStudentId = lookup.rows[0].id;
    } else {
      // Handle numeric registration numbers
      numericStudentId = parseInt(id, 10);
      if (Number.isNaN(numericStudentId)) {
        return res.status(400).json({ 
          error: `Invalid student ID format: ${id}`,
          expected: "STU001 or numeric registration number"
        });
      }
    }

    const totalClassesResult = await db.query(
      'SELECT COUNT(DISTINCT session_date) AS total_classes FROM attendance WHERE student_id = $1',
      [numericStudentId]
    );
    const attendedResult = await db.query(
      'SELECT COUNT(DISTINCT session_date) AS attended_classes FROM attendance WHERE student_id = $1 AND present = true',
      [numericStudentId]
    );
    const recentResult = await db.query(`
      SELECT a.session_date, a.present, a.method, a.recorded_at, c.code as class_code, c.name as class_name
      FROM attendance a
      JOIN classes c ON c.id = a.class_id
      WHERE a.student_id = $1
      ORDER BY a.session_date DESC, a.recorded_at DESC
      LIMIT 20
    `, [numericStudentId]);

    const totalClasses = parseInt(totalClassesResult.rows[0].total_classes || 0, 10);
    const attendedClasses = parseInt(attendedResult.rows[0].attended_classes || 0, 10);

    res.json({
      student_id: numericStudentId,
      total_classes: totalClasses,
      attended_classes: attendedClasses,
      attendance_rate: totalClasses > 0 ? Math.round((attendedClasses / totalClasses) * 100) : 0,
      recent_records: recentResult.rows
    });
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    res.status(500).json({ error: error.message });
  }
});


// =======================================
// 2️⃣ Get Attendance for a Class on a Specific Date
// =======================================
router.get('/class/:classId/date/:date', async (req, res) => {
  console.log("📊 Attendance class/date route hit:", req.originalUrl);
  try {
    const { classId, date } = req.params;
    const sessionId = req.query.sessionId ? parseInt(req.query.sessionId, 10) : null;
    if (req.query.sessionId && Number.isNaN(sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    const result = sessionId
      ? await db.query(`
        SELECT 
          s.id, s.student_id, s.name, 
          CASE 
            WHEN s.photo_url IS NOT NULL AND s.photo_url != '' THEN 
              CASE WHEN s.photo_url LIKE 'http%' THEN s.photo_url ELSE '/uploads/' || s.photo_url END
            ELSE NULL 
          END as photo_url,
          COALESCE(a.present, false) AS present,
          a.method, a.confidence, a.recorded_at
        FROM students s
        JOIN enrollments e ON s.id = e.student_id
        LEFT JOIN attendance a 
          ON a.student_id = s.id 
          AND a.class_id = $1 
          AND a.session_id = $2
        WHERE e.class_id = $1
        ORDER BY s.name;
      `, [classId, sessionId])
      : await db.query(`
        SELECT 
          s.id, s.student_id, s.name, 
          CASE 
            WHEN s.photo_url IS NOT NULL AND s.photo_url != '' THEN 
              CASE WHEN s.photo_url LIKE 'http%' THEN s.photo_url ELSE '/uploads/' || s.photo_url END
            ELSE NULL 
          END as photo_url,
          COALESCE(a.present, false) AS present,
          a.method, a.confidence, a.recorded_at
        FROM students s
        JOIN enrollments e ON s.id = e.student_id
        LEFT JOIN attendance a 
          ON a.student_id = s.id 
          AND a.class_id = $1 
          AND a.session_date = $2
        WHERE e.class_id = $1
        ORDER BY s.name;
      `, [classId, date]);

    // Always return array, never 404
    res.json(result.rows || []);

  } catch (error) {
    console.error('❌ Error fetching attendance by date:', error);
    res.status(500).json({ error: error.message });
  }
});


// =======================================
// 3️⃣ Get Class Attendance Statistics
// =======================================
router.get('/class/:classId/stats', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.id, s.student_id, s.name, s.email,
        COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) AS total_present,
        COUNT(DISTINCT a.session_date) AS total_sessions,
        CASE 
          WHEN COUNT(DISTINCT a.session_date) = 0 THEN 0
          ELSE ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END)::numeric / 
             COUNT(DISTINCT a.session_date)) * 100, 2
          )
        END AS attendance_percentage
      FROM students s
      JOIN enrollments e ON s.id = e.student_id
      LEFT JOIN attendance a ON a.student_id = s.id AND a.class_id = $1
      WHERE e.class_id = $1
      GROUP BY s.id, s.student_id, s.name, s.email
      ORDER BY attendance_percentage DESC NULLS LAST, s.name;
    `, [req.params.classId]);

    // Clamp percentages between 0 and 100
    const clampedResults = result.rows.map(row => ({
      ...row,
      attendance_percentage: Math.min(100, Math.max(0, row.attendance_percentage))
    }));

    res.json(clampedResults);

  } catch (error) {
    console.error('❌ Error fetching stats:', error);
    res.status(500).json({ error: error.message });
  }
});


// =======================================
// 4️⃣ Filter Students Above 75% Attendance
// =======================================
router.get('/class/:classId/stats/above75', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        s.id, s.student_id, s.name, s.email,
        COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) AS total_present,
        (SELECT COUNT(DISTINCT session_date) FROM attendance WHERE class_id = $1) AS total_sessions,
        CASE 
          WHEN (SELECT COUNT(DISTINCT session_date) FROM attendance WHERE class_id = $1) = 0 THEN 0
          ELSE ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END)::numeric /
              (SELECT COUNT(DISTINCT session_date) FROM attendance WHERE class_id = $1)) * 100, 2
          )
        END AS attendance_percentage
      FROM students s
      JOIN enrollments e ON s.id = e.student_id
      LEFT JOIN attendance a ON a.student_id = s.id AND a.class_id = $1
      WHERE e.class_id = $1
      GROUP BY s.id, s.student_id, s.name, s.email
      HAVING 
        (CASE 
          WHEN COUNT(DISTINCT a.session_date) = 0 THEN 0
          ELSE ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END)::numeric /
              COUNT(DISTINCT a.session_date)) * 100, 2
          )
        END) >= 75
      ORDER BY attendance_percentage DESC, s.name;
    `, [req.params.classId]);

    res.json(result.rows);

  } catch (error) {
    console.error('❌ Error fetching students above 75%:', error);
    res.status(500).json({ error: error.message });
  }
});


// =======================================
// 5️⃣ Get Attendance Dates for a Class
// =======================================
router.get('/class/:classId/dates', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT session_date,
             COUNT(*) AS present_count,
             (SELECT COUNT(*) FROM enrollments WHERE class_id = $1) AS total_students
      FROM attendance 
      WHERE class_id = $1 AND present = true
      GROUP BY session_date
      ORDER BY session_date DESC;
    `, [req.params.classId]);

    res.json(result.rows);

  } catch (error) {
    console.error('❌ Error fetching attendance dates:', error);
    res.status(500).json({ error: error.message });
  }
});


// =======================================
// 6️⃣ Health Check (optional for debugging)
// =======================================
router.get('/health', (req, res) => {
  res.json({ status: 'ok', route: 'attendance', timestamp: new Date() });
});


// =======================================
// 📊 Get Attendance Session Analytics
// =======================================
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Get session details
    const sessionResult = await db.query(`
      SELECT cs.*, c.code as class_code, c.name as class_name
      FROM class_schedules cs
      JOIN classes c ON c.id = cs.class_id
      WHERE cs.id = $1
    `, [sessionId]);

    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];

    // Get attendance records for this session
    const sessionDate = session.scheduled_date || new Date().toISOString().slice(0, 10);
    const recordsResult = await db.query(`
      SELECT 
        s.student_id,
        s.name as student_name,
        COALESCE(a.present, false) as present,
        COALESCE(a.method, 'manual') as method,
        COALESCE(a.recorded_at, NOW())::text as timestamp
      FROM students s
      JOIN enrollments e ON e.student_id = s.id
      LEFT JOIN attendance a ON a.student_id = s.id 
        AND a.class_id = $1
        AND a.session_date = $2
      WHERE e.class_id = $1
      ORDER BY s.name
    `, [session.class_id, sessionDate]);

    const records = recordsResult.rows;
    const stats = {
      total: records.length,
      present: records.filter(r => r.present).length,
      absent: records.filter(r => !r.present).length,
      percentage: records.length > 0 ? 
        Math.round((records.filter(r => r.present).length / records.length) * 100) : 0
    };

    res.json({
      session: {
        id: session.id,
        class_name: session.class_name,
        class_code: session.class_code,
        session_date: sessionDate,
        start_time: session.start_time,
        end_time: session.end_time,
        room_number: session.room_number
      },
      stats,
      records: records.map(record => ({
        student_id: record.student_id,
        student_name: record.student_name,
        status: record.present ? 'present' : 'absent',
        method: record.method,
        timestamp: record.timestamp
      }))
    });

  } catch (error) {
    console.error('Error fetching session analytics:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/session/:sessionId/records', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const sessionResult = await db.query(
      'SELECT id, class_id, scheduled_date FROM class_schedules WHERE id = $1',
      [sessionId]
    );
    if (sessionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = sessionResult.rows[0];
    const sessionDate = session.scheduled_date || new Date().toISOString().slice(0, 10);
    const recordsResult = await db.query(`
      SELECT 
        s.student_id,
        s.name as student_name,
        COALESCE(a.present, false) as present,
        COALESCE(a.method, 'manual') as method,
        COALESCE(a.recorded_at, NOW())::text as timestamp
      FROM students s
      JOIN enrollments e ON e.student_id = s.id
      LEFT JOIN attendance a ON a.student_id = s.id
        AND a.class_id = $1
        AND a.session_date = $2
      WHERE e.class_id = $1
      ORDER BY s.name
    `, [session.class_id, sessionDate]);

    const records = recordsResult.rows.map((record) => ({
      student_id: record.student_id,
      student_name: record.student_name,
      status: record.present ? 'present' : 'absent',
      method: record.method,
      timestamp: record.timestamp
    }));

    const present = records.filter((r) => r.status === 'present').length;
    const total = records.length;

    res.json({
      records,
      stats: {
        total,
        present,
        absent: total - present,
        percentage: total > 0 ? Math.round((present / total) * 100) : 0
      }
    });
  } catch (error) {
    console.error('Error fetching session records:', error);
    res.status(500).json({ error: error.message });
  }
});

// =======================================
// 4️⃣ Get Attendance for a Specific Student
// =======================================
router.get('/student/:studentId', async (req, res) => {
  console.log("👤 Student attendance route hit:", req.originalUrl);
  try {
    const { studentId } = req.params;
    
    // Convert string student_id to numeric database ID if needed
    let numericStudentId;
    if (typeof studentId === 'string' && isNaN(studentId)) {
      const lookup = await db.query('SELECT id FROM students WHERE student_id = $1', [studentId]);
      if (lookup.rows.length === 0) {
        return res.status(404).json({ error: `Student ${studentId} not found` });
      }
      numericStudentId = lookup.rows[0].id;
    } else {
      numericStudentId = parseInt(studentId);
    }
    
    // Get all classes the student is enrolled in
    const enrolledClassesResult = await db.query(`
      SELECT DISTINCT c.id, c.code, c.name
      FROM classes c
      JOIN enrollments e ON c.id = e.class_id
      WHERE e.student_id = $1
      ORDER BY c.code
    `, [numericStudentId]);
    
    const allAttendanceRecords = [];
    
    // For each enrolled class, get unique attendance sessions (deduplicated)
    for (const classInfo of enrolledClassesResult.rows) {
      const classAttendanceResult = await db.query(`
        SELECT DISTINCT ON (session_date)
          a.id,
          a.session_date,
          a.present,
          a.method,
          a.confidence,
          a.recorded_at,
          '${classInfo.code}' as class_code,
          '${classInfo.name}' as class_name,
          s.name as student_name,
          s.student_id
        FROM attendance a
        JOIN students s ON s.id = a.student_id
        WHERE a.class_id = $1 AND a.student_id = $2
        ORDER BY session_date DESC, recorded_at DESC
      `, [classInfo.id, numericStudentId]);
      
      allAttendanceRecords.push(...classAttendanceResult.rows);
    }
    
    // Sort all records by date
    allAttendanceRecords.sort((a, b) => {
      const dateCompare = new Date(b.session_date) - new Date(a.session_date);
      if (dateCompare !== 0) return dateCompare;
      return new Date(b.recorded_at) - new Date(a.recorded_at);
    });
    
    // Calculate attendance statistics using distinct sessions
    const uniqueSessions = new Set(allAttendanceRecords.map(r => `${r.session_date}-${r.class_code}`));
    const totalSessions = uniqueSessions.size;
    const presentSessions = allAttendanceRecords.filter(r => r.present).length;
    const absentSessions = totalSessions - presentSessions;
    const attendanceRate = totalSessions > 0 ? (presentSessions / totalSessions * 100).toFixed(2) : 0;
    
    console.log(`📊 Student ${studentId} attendance summary:`, {
      totalSessions,
      presentSessions,
      absentSessions,
      attendanceRate
    });
    
    res.json({
      recent_records: allAttendanceRecords,
      total_sessions: totalSessions,
      present_sessions: presentSessions,
      absent_sessions: absentSessions,
      attendance_rate: parseFloat(attendanceRate)
    });
    
  } catch (error) {
    console.error('Error fetching student attendance:', error);
    res.status(500).json({ error: error.message });
  }
});

// =======================================
// 🎓 Finalize Attendance Session
// =======================================
router.post('/finalize', async (req, res) => {
  console.log("🎓 Attendance finalization route hit:", req.originalUrl);
  try {
    const { class_id, session_date, session_id, recognized_student_ids } = req.body;

    console.log('🎓 FINALIZATION REQUEST:', { 
      class_id, 
      session_date, 
      session_id,
      recognized_student_ids,
      bodyKeys: Object.keys(req.body)
    });

    if (!class_id || !session_date) {
      console.log('❌ MISSING REQUIRED FIELDS:', { class_id, session_date });
      return res.status(400).json({ 
        error: 'class_id and session_date are required' 
      });
    }

    // Convert recognized_student_ids to array if it's a string
    let recognizedIds = recognized_student_ids || [];
    if (typeof recognizedIds === 'string') {
      recognizedIds = recognizedIds.split(',').map(id => id.trim());
    }

    const result = await manualFinalizeAttendance(
      parseInt(class_id), 
      session_date, 
      session_id ? parseInt(session_id) : null, 
      recognizedIds
    );

    console.log('✅ Attendance finalization completed:', result);
    res.json({ 
      success: true, 
      message: 'Attendance session finalized successfully',
      ...result
    });

  } catch (error) {
    console.error('❌ Attendance finalization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =======================================
// 🎓 Auto-Finalize Attendance (called by frontend when session ends)
// =======================================
router.post('/auto-finalize', async (req, res) => {
  console.log("🎓 Auto attendance finalization route hit:", req.originalUrl);
  try {
    const { class_id, session_date, session_id } = req.body;

    if (!class_id || !session_date) {
      return res.status(400).json({ 
        error: 'class_id and session_date are required' 
      });
    }

    // Get currently recognized students for this session
    const recognizedResult = await db.query(`
      SELECT DISTINCT s.student_id
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      WHERE a.class_id = $1 
        AND a.session_date = $2 
        AND a.present = true
        ${session_id ? 'AND a.session_id = $3' : 'AND a.session_id IS NULL'}
    `, session_id ? [parseInt(class_id), session_date, parseInt(session_id)] : [parseInt(class_id), session_date]);

    const recognizedStudentIds = recognizedResult.rows.map(row => row.student_id);
    
    const result = await finalizeAttendanceSession(
      parseInt(class_id), 
      session_date, 
      session_id ? parseInt(session_id) : null, 
      recognizedStudentIds
    );

    console.log('✅ Auto attendance finalization completed:', result);
    res.json({ 
      success: true, 
      message: 'Attendance automatically finalized',
      ...result
    });

  } catch (error) {
    console.error('❌ Auto attendance finalization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =======================================
// ✅ Export Routes
// =======================================
module.exports = router;
