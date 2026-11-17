import { Router } from 'express';
import { login, me, register, updateMySettings } from '../controllers/authController.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/login', login);
// First admin of a new install only (refused once any user exists).
router.post('/register', register);
router.get('/me', requireAuth, me);
router.put('/settings', requireAuth, updateMySettings);

export default router;
