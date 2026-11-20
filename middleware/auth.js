import jwt from 'jsonwebtoken'

// Verifies the short-lived JWT issued by the Next.js bridge.
// The secret is read at request time so dotenv.config() in index.js has run.
export function verifyToken(req, res, next) {
  const header = req.headers.authorization ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  if (!token) {
    return res.status(401).json({ message: 'Authentication required.' })
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] })
    req.user = {
      id: payload.sub,
      role: payload.role,
      email: payload.email,
      name: payload.name,
      plan: payload.plan,
    }
    next()
  } catch (error) {
    const expired = error?.name === 'TokenExpiredError'
    return res.status(401).json({
      message: expired ? 'Session expired — please sign in again.' : 'Invalid authentication token.',
    })
  }
}

// Role-based authorization on top of verifyToken.
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: 'Authentication required.' })
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission for this action.' })
    }
    next()
  }
}

// Ownership guard helper — compares normalized ids/emails.
export function isOwner(req, doc, idField = 'vendorId', emailField = 'vendorEmail') {
  return (
    (idField && doc?.[idField] && String(doc[idField]) === String(req.user?.id)) ||
    (emailField && doc?.[emailField] && String(doc[emailField]).toLowerCase() === String(req.user?.email).toLowerCase())
  )
}
