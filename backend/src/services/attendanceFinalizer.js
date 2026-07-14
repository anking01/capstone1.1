// =======================================
// 🎓 Attendance Finalizer Service
// Automatically marks students as absent when session ends
// =======================================

const db = require('../db');

/**
 * Finalize attendance for a session by marking unrecognized students as absent
 * @param {number} classId - Class ID
 * @param {string} sessionDate - Session date (YYYY-MM-DD)
 * @param {number|null} sessionId - Session ID (for scheduled classes) or null
 * @param {Array<string>} recognizedStudentIds - Array of recognized student_id strings (STU001, etc.)
 */
async function finalizeAttendanceSession(classId, sessionDate, sessionId = null, recognizedStudentIds = []) {
  console.log('🎓 Finalizing attendance session:', {
    classId,
    sessionDate,
    sessionId,
    recognizedCount: recognizedStudentIds.length,
    recognizedStudents: recognizedStudentIds
  });

  try {
    // Step 1: Get all enrolled students for this class
    const enrolledStudentsResult = await db.query(`
      SELECT s.id, s.student_id, s.name
      FROM students s
      JOIN enrollments e ON s.id = e.student_id
      WHERE e.class_id = $1
      ORDER BY s.student_id
    `, [classId]);

    const enrolledStudents = enrolledStudentsResult.rows;
    console.log(`📚 Found ${enrolledStudents.length} enrolled students for class ${classId}`);

    // Step 2: Get already recorded attendance for this session
    let existingAttendanceQuery;
    let queryParams;

    if (sessionId) {
      // Session-based attendance
      existingAttendanceQuery = `
        SELECT student_id, present, method
        FROM attendance 
        WHERE class_id = $1 AND session_id = $2
      `;
      queryParams = [classId, sessionId];
    } else {
      // Date-based attendance
      existingAttendanceQuery = `
        SELECT student_id, present, method
        FROM attendance 
        WHERE class_id = $1 AND session_date = $2 AND session_id IS NULL
      `;
      queryParams = [classId, sessionDate];
    }

    const existingAttendanceResult = await db.query(existingAttendanceQuery, queryParams);
    const existingAttendance = existingAttendanceResult.rows;
    
    console.log(`📊 Found ${existingAttendance.length} existing attendance records`);

    // Step 3: Identify students who need to be marked as absent
    const studentsToMarkAbsent = [];

    for (const student of enrolledStudents) {
      const hasRecord = existingAttendance.find(record => record.student_id === student.id);
      const wasRecognized = recognizedStudentIds.includes(student.student_id);

      if (!hasRecord && !wasRecognized) {
        // No attendance record AND not recognized = mark as absent
        console.log(`❌ Marking ${student.student_id} as absent (no record, not recognized)`);
        studentsToMarkAbsent.push({
          studentId: student.id,
          studentCode: student.student_id,
          name: student.name
        });
      } else if (hasRecord && !hasRecord.present && wasRecognized) {
        // Has absent record but was recognized = update to present
        console.log(`🔄 Updating ${student.student_id} from absent to present (was recognized)`);
        await updateAttendanceRecord(classId, sessionDate, sessionId, student.id, true, 'face', 1.0);
      } else if (hasRecord && hasRecord.present && !wasRecognized) {
        // Has present record but wasn't in recognized list (shouldn't happen, but log it)
        console.log(`⚠️ Student ${student.student_id} has present record but wasn't in recognized list`);
      }
    }

    // Step 4: Mark unrecognized students as absent
    if (studentsToMarkAbsent.length > 0) {
      console.log(`❌ Marking ${studentsToMarkAbsent.length} students as absent:`, 
        studentsToMarkAbsent.map(s => s.studentCode));

      for (const student of studentsToMarkAbsent) {
        await createAbsentRecord(classId, sessionDate, sessionId, student.studentId);
      }
    } else {
      console.log('✅ All students have attendance records - no absent marks needed');
    }

    // Step 5: Generate final summary
    const finalStats = await generateAttendanceSummary(classId, sessionDate, sessionId);
    
    console.log('📈 Attendance finalization complete:', finalStats);
    
    return {
      success: true,
      stats: finalStats,
      markedAbsent: studentsToMarkAbsent.length,
      totalEnrolled: enrolledStudents.length
    };

  } catch (error) {
    console.error('❌ Error finalizing attendance session:', error);
    throw error;
  }
}

/**
 * Create an absent attendance record
 */
async function createAbsentRecord(classId, sessionDate, sessionId, studentId) {
  try {
    let query;
    let params;

    if (sessionId) {
      // Session-based absent record
      query = `
        INSERT INTO attendance (class_id, student_id, session_id, session_date, present, method, confidence, recorded_at)
        VALUES ($1, $2, $3, $4, false, 'auto_absent', 0.0, NOW())
        ON CONFLICT (class_id, student_id, session_id)
        WHERE session_id IS NOT NULL
        DO UPDATE SET present = false, method = 'auto_absent', confidence = 0.0, recorded_at = NOW()
        RETURNING *
      `;
      params = [classId, studentId, sessionId, sessionDate];
    } else {
      // Date-based absent record
      query = `
        INSERT INTO attendance (class_id, student_id, session_date, present, method, confidence, recorded_at)
        VALUES ($1, $2, $3, false, 'auto_absent', 0.0, NOW())
        ON CONFLICT (class_id, student_id, session_date)
        WHERE session_id IS NULL
        DO UPDATE SET present = false, method = 'auto_absent', confidence = 0.0, recorded_at = NOW()
        RETURNING *
      `;
      params = [classId, studentId, sessionDate];
    }

    const result = await db.query(query, params);
    console.log(`✅ Created absent record for student ${studentId}`);
    return result.rows[0];

  } catch (error) {
    console.error(`❌ Error creating absent record for student ${studentId}:`, error);
    throw error;
  }
}

/**
 * Update an existing attendance record (e.g., change absent to present)
 */
async function updateAttendanceRecord(classId, sessionDate, sessionId, studentId, present, method, confidence) {
  try {
    let query;
    let params;

    if (sessionId) {
      query = `
        UPDATE attendance 
        SET present = $1, method = $2, confidence = $3, recorded_at = NOW()
        WHERE class_id = $4 AND student_id = $5 AND session_id = $6
        RETURNING *
      `;
      params = [present, method, confidence, classId, studentId, sessionId];
    } else {
      query = `
        UPDATE attendance 
        SET present = $1, method = $2, confidence = $3, recorded_at = NOW()
        WHERE class_id = $4 AND student_id = $5 AND session_date = $6 AND session_id IS NULL
        RETURNING *
      `;
      params = [present, method, confidence, classId, studentId, sessionDate];
    }

    const result = await db.query(query, params);
    return result.rows[0];

  } catch (error) {
    console.error(`❌ Error updating attendance record for student ${studentId}:`, error);
    throw error;
  }
}

/**
 * Generate attendance summary for the session
 */
async function generateAttendanceSummary(classId, sessionDate, sessionId) {
  try {
    let query;
    let params;

    if (sessionId) {
      query = `
        SELECT 
          COUNT(*) as total_students,
          COUNT(CASE WHEN present = true THEN 1 END) as present_count,
          COUNT(CASE WHEN present = false THEN 1 END) as absent_count,
          ROUND(
            (COUNT(CASE WHEN present = true THEN 1 END)::numeric / COUNT(*)) * 100, 2
          ) as attendance_percentage
        FROM attendance a
        WHERE a.class_id = $1 AND a.session_id = $2
      `;
      params = [classId, sessionId];
    } else {
      query = `
        SELECT 
          COUNT(*) as total_students,
          COUNT(CASE WHEN present = true THEN 1 END) as present_count,
          COUNT(CASE WHEN present = false THEN 1 END) as absent_count,
          ROUND(
            (COUNT(CASE WHEN present = true THEN 1 END)::numeric / COUNT(*)) * 100, 2
          ) as attendance_percentage
        FROM attendance a
        WHERE a.class_id = $1 AND a.session_date = $2 AND a.session_id IS NULL
      `;
      params = [classId, sessionDate];
    }

    const result = await db.query(query, params);
    return result.rows[0];

  } catch (error) {
    console.error('❌ Error generating attendance summary:', error);
    throw error;
  }
}

/**
 * Manual endpoint to trigger attendance finalization
 * Useful for testing or manual session completion
 */
async function manualFinalizeAttendance(classId, sessionDate, sessionId = null) {
  console.log('🔧 Manual attendance finalization triggered:', { classId, sessionDate, sessionId });
  
  try {
    // Get recognized students from the current session
    const recognizedStudentsResult = await db.query(`
      SELECT DISTINCT s.student_id
      FROM attendance a
      JOIN students s ON a.student_id = s.id
      WHERE a.class_id = $1 
        AND a.session_date = $2 
        AND a.present = true
        ${sessionId ? 'AND a.session_id = $3' : 'AND a.session_id IS NULL'}
    `, sessionId ? [classId, sessionDate, sessionId] : [classId, sessionDate]);

    const recognizedStudentIds = recognizedStudentsResult.rows.map(row => row.student_id);
    
    return await finalizeAttendanceSession(classId, sessionDate, sessionId, recognizedStudentIds);
    
  } catch (error) {
    console.error('❌ Manual attendance finalization failed:', error);
    throw error;
  }
}

module.exports = {
  finalizeAttendanceSession,
  manualFinalizeAttendance,
  createAbsentRecord,
  updateAttendanceRecord,
  generateAttendanceSummary
};
