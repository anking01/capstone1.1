const db = require('../db');

class AnalyticsService {
  async getAttendanceTrends(classId, period = '30d') {
    try {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
      const query = `
        SELECT 
          session_date,
          COUNT(DISTINCT a.student_id) as total_students,
          COUNT(DISTINCT CASE WHEN a.present = true THEN a.student_id END) as present_students,
          ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.student_id END) * 100.0 / COUNT(DISTINCT a.student_id)), 2
          ) as attendance_percentage
        FROM attendance a
        WHERE class_id = $1
          AND session_date >= NOW() - INTERVAL '${days} days'
        GROUP BY session_date 
        ORDER BY session_date ASC
      `;
      
      const result = await db.query(query, [classId]);
      return result.rows;
    } catch (error) {
      console.error('Error getting attendance trends:', error);
      throw error;
    }
  }

  async getRiskStudents(threshold = 75) {
    try {
      const query = `
        SELECT 
          s.id,
          s.student_id,
          s.name,
          s.email,
          COUNT(DISTINCT a.session_date) as total_sessions,
          COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) as present_sessions,
          ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) * 100.0 / COUNT(DISTINCT a.session_date)), 2
          ) as attendance_percentage
        FROM students s
        JOIN attendance a ON s.id = a.student_id
        WHERE a.session_date >= NOW() - INTERVAL '30 days'
        GROUP BY s.id, s.student_id, s.name, s.email
        HAVING (COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) * 100.0 / COUNT(DISTINCT a.session_date)) < $1
        ORDER BY attendance_percentage ASC
      `;
      
      const result = await db.query(query, [threshold]);
      return result.rows;
    } catch (error) {
      console.error('Error getting risk students:', error);
      throw error;
    }
  }

  async getSectionSummary(classId) {
    try {
      const query = `
        SELECT 
          c.id,
          c.name,
          c.code,
          COUNT(DISTINCT e.student_id) as enrolled_students,
          COUNT(DISTINCT a.student_id) as active_students,
          ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.student_id END) * 100.0 / 
             NULLIF(COUNT(DISTINCT e.student_id), 0)), 2
          ) as overall_attendance,
          COUNT(DISTINCT CASE WHEN a.session_date >= NOW() - INTERVAL '7 days' THEN a.student_id END) as weekly_active
        FROM classes c
        LEFT JOIN enrollments e ON c.id = e.class_id
        LEFT JOIN attendance a ON c.id = a.class_id
        WHERE c.id = $1
        GROUP BY c.id, c.name, c.code
      `;
      
      const result = await db.query(query, [classId]);
      return result.rows[0];
    } catch (error) {
      console.error('Error getting section summary:', error);
      throw error;
    }
  }

  async getWeeklyAttendance(classId) {
    try {
      const query = `
        SELECT 
          EXTRACT(DOW FROM session_date) as day_of_week,
          COUNT(*) as sessions,
          AVG(CASE WHEN present = true THEN 100.0 ELSE 0.0 END) as avg_attendance
        FROM attendance 
        WHERE class_id = $1 
          AND session_date >= NOW() - INTERVAL '8 weeks'
        GROUP BY day_of_week 
        ORDER BY day_of_week
      `;
      
      const result = await db.query(query, [classId]);
      return result.rows;
    } catch (error) {
      console.error('Error getting weekly attendance:', error);
      throw error;
    }
  }

  async getMonthlyAttendance(classId) {
    try {
      const query = `
        SELECT 
          DATE_TRUNC('month', session_date) as month,
          COUNT(*) as sessions,
          AVG(CASE WHEN present = true THEN 100.0 ELSE 0.0 END) as avg_attendance
        FROM attendance 
        WHERE class_id = $1 
          AND session_date >= NOW() - INTERVAL '12 months'
        GROUP BY month 
        ORDER BY month ASC
      `;
      
      const result = await db.query(query, [classId]);
      return result.rows;
    } catch (error) {
      console.error('Error getting monthly attendance:', error);
      throw error;
    }
  }

  async getAttendanceHeatmap(classId) {
    try {
      const query = `
        SELECT 
          session_date,
          EXTRACT(DOW FROM session_date) as day_of_week,
          COUNT(DISTINCT a.student_id) as total_students,
          COUNT(DISTINCT CASE WHEN a.present = true THEN a.student_id END) as present_students,
          ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.student_id END) * 100.0 / COUNT(DISTINCT a.student_id)), 2
          ) as attendance_percentage
        FROM attendance a
        WHERE class_id = $1
          AND session_date >= NOW() - INTERVAL '12 weeks'
        GROUP BY session_date, day_of_week 
        ORDER BY session_date DESC
      `;
      
      const result = await db.query(query, [classId]);
      return result.rows;
    } catch (error) {
      console.error('Error getting attendance heatmap:', error);
      throw error;
    }
  }

  async getMethodDistribution(classId) {
    try {
      const query = `
        SELECT 
          method,
          COUNT(*) as count,
          ROUND(
            (COUNT(*) * 100.0 / (SELECT COUNT(*) FROM attendance WHERE class_id = $1)), 2
          ) as percentage
        FROM attendance 
        WHERE class_id = $1 
          AND session_date >= NOW() - INTERVAL '30 days'
        GROUP BY method 
        ORDER BY count DESC
      `;
      
      const result = await db.query(query, [classId]);
      return result.rows;
    } catch (error) {
      console.error('Error getting method distribution:', error);
      throw error;
    }
  }

  async getTopPerformers(classId, limit = 10) {
    try {
      const query = `
        SELECT 
          s.id,
          s.student_id,
          s.name,
          COUNT(DISTINCT a.session_date) as total_sessions,
          COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) as present_sessions,
          ROUND(
            (COUNT(DISTINCT CASE WHEN a.present = true THEN a.session_date END) * 100.0 / COUNT(DISTINCT a.session_date)), 2
          ) as attendance_percentage
        FROM students s
        JOIN attendance a ON s.id = a.student_id
        WHERE a.class_id = $1 
          AND a.session_date >= NOW() - INTERVAL '30 days'
        GROUP BY s.id, s.student_id, s.name
        ORDER BY attendance_percentage DESC
        LIMIT $2
      `;
      
      const result = await db.query(query, [classId, limit]);
      return result.rows;
    } catch (error) {
      console.error('Error getting top performers:', error);
      throw error;
    }
  }
}

module.exports = new AnalyticsService();
