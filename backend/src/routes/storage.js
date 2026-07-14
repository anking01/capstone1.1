const express = require('express');
const router = express.Router();
const multer = require('multer');
const awsStorageService = require('../services/aws_storage');
const { requireAuth, requireTeacher } = require('../middleware/auth');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// Initialize storage (S3 bucket or local fallback)
router.post('/initialize', requireTeacher, async (req, res) => {
  try {
    await awsStorageService.initializeContainer();
    res.json({ success: true, message: 'Storage initialized' });
  } catch (error) {
    console.error('Storage initialization error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload face image for student
router.post('/upload-face/:studentId', requireTeacher, upload.single('image'), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }

    const result = await awsStorageService.uploadFaceImage(
      studentId,
      req.file.buffer,
      req.file.originalname
    );

    res.json({ 
      success: true, 
      message: 'Face image uploaded successfully',
      data: result
    });
  } catch (error) {
    console.error('Face image upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get face image for student
router.get('/face/:studentId/:fileName', requireAuth, async (req, res) => {
  try {
    const { studentId, fileName } = req.params;
    
    const imageData = await awsStorageService.getFaceImage(studentId, fileName);
    
    res.set('Content-Type', imageData.contentType);
    res.send(imageData.buffer);
  } catch (error) {
    console.error('Face image retrieval error:', error);
    res.status(500).json({ error: error.message });
  }
});

// List all face images for a student
router.get('/faces/:studentId', requireAuth, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const images = await awsStorageService.listFaceImages(studentId);
    
    res.json({ 
      success: true, 
      data: images,
      count: images.length
    });
  } catch (error) {
    console.error('List face images error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete specific face image
router.delete('/face/:studentId/:fileName', requireTeacher, async (req, res) => {
  try {
    const { studentId, fileName } = req.params;
    
    await awsStorageService.deleteFaceImage(studentId, fileName);
    
    res.json({ 
      success: true, 
      message: 'Face image deleted successfully'
    });
  } catch (error) {
    console.error('Face image deletion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete all face images for a student
router.delete('/faces/:studentId', requireTeacher, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    await awsStorageService.deleteAllFaceImages(studentId);
    
    res.json({ 
      success: true, 
      message: 'All face images deleted successfully'
    });
  } catch (error) {
    console.error('Delete all face images error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload face encoding data
router.post('/encoding/:studentId', requireTeacher, async (req, res) => {
  try {
    const { studentId } = req.params;
    const encodingData = req.body;
    
    if (!encodingData) {
      return res.status(400).json({ error: 'No encoding data provided' });
    }

    const result = await awsStorageService.uploadFaceEncoding(studentId, encodingData);
    
    res.json({ 
      success: true, 
      message: 'Face encoding uploaded successfully',
      data: result
    });
  } catch (error) {
    console.error('Face encoding upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get face encoding for student
router.get('/encoding/:studentId', requireAuth, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    const encoding = await awsStorageService.getFaceEncoding(studentId);
    
    if (!encoding) {
      return res.status(404).json({ error: 'Face encoding not found' });
    }
    
    res.json({ 
      success: true, 
      data: encoding
    });
  } catch (error) {
    console.error('Face encoding retrieval error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete face encoding for student
router.delete('/encoding/:studentId', requireTeacher, async (req, res) => {
  try {
    const { studentId } = req.params;
    
    await awsStorageService.deleteFaceEncoding(studentId);
    
    res.json({ 
      success: true, 
      message: 'Face encoding deleted successfully'
    });
  } catch (error) {
    console.error('Face encoding deletion error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get storage statistics
router.get('/stats', requireTeacher, async (req, res) => {
  try {
    const stats = await awsStorageService.getStorageStats();
    
    res.json({ 
      success: true, 
      data: stats
    });
  } catch (error) {
    console.error('Storage stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Batch upload multiple face images
router.post('/batch-upload/:studentId', requireTeacher, upload.array('images', 5), async (req, res) => {
  try {
    const { studentId } = req.params;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }

    const uploadPromises = req.files.map(file => 
      awsStorageService.uploadFaceImage(studentId, file.buffer, file.originalname)
    );

    const results = await Promise.all(uploadPromises);
    
    res.json({ 
      success: true, 
      message: `${results.length} face images uploaded successfully`,
      data: results
    });
  } catch (error) {
    console.error('Batch upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
