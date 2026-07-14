const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const db = require('../db');

// Configure file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../../uploads/');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Get all students
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, student_id, name, email, 
             CASE 
               WHEN photo_url IS NOT NULL AND photo_url != '' THEN 
                 CASE WHEN photo_url LIKE 'http%' THEN photo_url ELSE '/uploads/' || photo_url END
               ELSE NULL 
             END as photo_url,
             created_at FROM students ORDER BY name
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get single student
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT *,
             CASE
               WHEN photo_url IS NOT NULL AND photo_url != '' THEN
                 CASE WHEN photo_url LIKE 'http%' OR photo_url LIKE '/%' THEN photo_url ELSE '/uploads/' || photo_url END
               ELSE NULL
             END as photo_url
      FROM students WHERE id = $1
    `, [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new student with photo
router.post('/', upload.single('photo'), async (req, res) => {
  try {
    console.log('📸 Student upload request received');
    console.log('📸 Request body:', req.body);
    console.log('📸 Uploaded file:', req.file);
    
    const { student_id, name, email } = req.body;

    if (!student_id || !name) {
      console.log('❌ Missing required fields:', { student_id, name });
      return res.status(400).json({ error: 'student_id and name are required' });
    }

    const photoPath = req.file ? req.file.filename : null;
    console.log('📸 Photo path extracted:', photoPath);
    
    // Insert student into database
    const result = await db.query(
      'INSERT INTO students (student_id, name, email, photo_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [student_id, name, email || null, photoPath]
    );
    
    const student = result.rows[0];
    console.log(`✓ Student created: ${student_id} - ${name}`);
    
    // If photo uploaded, enroll face
    if (req.file) {
      try {
        const formData = new FormData();
        formData.append('student_id', student_id);
        formData.append('image', fs.createReadStream(req.file.path));
        
        const faceServiceUrl = process.env.FACE_SERVICE_URL || 'http://localhost:5001';
        const response = await axios.post(`${faceServiceUrl}/enroll`, formData, {
          headers: formData.getHeaders(),
          timeout: 10000
        });
        
        console.log(`✓ Face enrolled for student ${student_id}`);
        student.face_enrolled = true;
      } catch (faceError) {
        console.error('⚠️  Face enrollment error:', faceError.message);
        student.face_enrolled = false;
        student.face_error = faceError.message;
      }
    }
    
    res.json({ success: true, student });
  } catch (error) {
    console.error('Student creation error:', error);
    if (error.code === '23505') { // Duplicate student_id
      return res.status(400).json({ error: 'Student ID already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// Get student attendance history
router.get('/:id/attendance', async (req, res) => {
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

    // Get all class sessions for this student and their attendance status
    let result;
    try {
      result = await db.query(`
        SELECT 
          cs.session_date,
          CASE WHEN a.present = true THEN 'present' ELSE 'absent' END as status
        FROM class_schedules cs
        JOIN enrollments e ON e.class_id = cs.class_id
        LEFT JOIN attendance a ON a.student_id = $1 
          AND a.class_id = cs.class_id 
          AND a.session_date = cs.session_date
        WHERE e.student_id = $1
        ORDER BY cs.session_date DESC
      `, [numericStudentId]);
    } catch (error) {
      console.log('class_schedules table not found, using attendance table fallback');
      result = await db.query(`
        SELECT 
          session_date,
          CASE WHEN present = true THEN 'present' ELSE 'absent' END as status
        FROM attendance
        WHERE student_id = $1
        ORDER BY session_date DESC
      `, [numericStudentId]);
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching student attendance history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete student
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Get student info first
    const student = await db.query('SELECT * FROM students WHERE id = $1', [id]);
    
    if (student.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    const studentData = student.rows[0];
    
    // Delete photo file if exists
    if (studentData.photo_url) {
      const photoPath = path.join(__dirname, '../../uploads/', studentData.photo_url);
      if (fs.existsSync(photoPath)) {
        fs.unlinkSync(photoPath);
      }
    }
    
    // Delete face encoding
    try {
      const faceServiceUrl = process.env.FACE_SERVICE_URL || 'http://localhost:5001';
      await axios.delete(`${faceServiceUrl}/unenroll/${studentData.student_id}`);
    } catch (error) {
      console.log('Face unenroll error (continuing):', error.message);
    }
    
    // Delete from database (CASCADE will handle enrollments and attendance)
    await db.query('DELETE FROM students WHERE id = $1', [id]);
    
    res.json({ success: true, message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Delete student error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;