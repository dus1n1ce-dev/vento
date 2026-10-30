import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

dotenv.config()

const { Pool } = pg
const root = path.dirname(fileURLToPath(import.meta.url))
const dataDirectory = path.join(root, 'data')
const port = Number(process.env.PORT || 3000)
const isProduction = process.env.NODE_ENV === 'production'
const adminLogin = process.env.BORCELLE_ADMIN_LOGIN
const adminPassword = process.env.BORCELLE_ADMIN_PASSWORD
const sessionSecret = process.env.BORCELLE_SESSION_SECRET || randomBytes(32).toString('hex')
const sessionLifetimeMs = 12 * 60 * 60 * 1000
const sessionCookie = 'borcelle_session'
const maxRequestBytes = 16 * 1024
const rateLimitWindowMs = 15 * 60 * 1000
const maxLoginAttempts = 5

if (!adminLogin || !adminPassword) {
  throw new Error('Set BORCELLE_ADMIN_LOGIN and BORCELLE_ADMIN_PASSWORD before starting the server.')
}

if (isProduction && !process.env.BORCELLE_SESSION_SECRET) {
  throw new Error('Set BORCELLE_SESSION_SECRET in production.')
}

if (isProduction && !process.env.DATABASE_URL) {
  throw new Error('Set DATABASE_URL in production so persistent data is not stored on the ephemeral service filesystem.')
}

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null
const localSessions = new Map()
const loginAttempts = new Map()
let localWriteQueue = Promise.resolve()
let vite

const defaultDishes = [
  {
    name: 'Буррата и инжир',
    category: 'starter',
    price: 1450,
    description: 'Спелый инжир, базилик, мёд и тёплая закваска.',
    image: 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=900&q=80',
  },
  {
    name: 'Кальмары с лимоном',
    category: 'starter',
    price: 1250,
    description: 'Лёгкая хрустящая корочка, травы и домашний айоли.',
    image: 'https://images.unsplash.com/photo-1559847844-5315695dadae?auto=format&fit=crop&w=900&q=80',
  },
  {
    name: 'Трюфельное ризотто',
    category: 'main',
    price: 1850,
    description: 'Рис арборио, чёрный трюфель и выдержанный пармезан.',
    image: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=900&q=80',
  },
  {
    name: 'Томлёная говядина',
    category: 'main',
    price: 2650,
    description: 'Нежное мясо, картофельный гратен и соус из красного вина.',
    image: 'https://images.unsplash.com/photo-1544025162-d76694265947?auto=format&fit=crop&w=900&q=80',
  },
  {
    name: 'Шоколадный фондан',
    category: 'dessert',
    price: 850,
    description: 'Тёплый тёмный шоколад, ванильный крем и сезонные ягоды.',
    image: 'https://images.unsplash.com/photo-1551024601-bec78aea704b?auto=format&fit=crop&w=900&q=80',
  },
  {
    name: 'Borcelle Sour',
    category: 'drink',
    price: 950,
    description: 'Джин, лимон и бузина с лёгкой цитрусовой нотой.',
    image: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?auto=format&fit=crop&w=900&q=80',
  },
].map((dish) => ({ id: randomUUID(), ...dish, available: true }))

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function signSession(id) {
  return createHmac('sha256', sessionSecret).update(id).digest('hex')
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function dateInBishkek() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bishkek',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

function mapDish(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    price: Number(row.price),
    description: row.description,
    image: row.image,
    available: row.available,
  }
}

function mapBooking(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    guests: row.guests,
    date: row.date,
    time: row.time,
    note: row.note,
    status: row.status,
    createdAt: row.createdAt ?? row.created_at,
  }
}

async function readLocalFile(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(dataDirectory, file), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`Could not read data/${file}: ${error.message}`, { cause: error })
  }
}

async function writeLocalFile(file, value) {
  const operation = localWriteQueue.then(async () => {
    await mkdir(dataDirectory, { recursive: true })
    const target = path.join(dataDirectory, file)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
  })
  localWriteQueue = operation.catch(() => {})
  return operation
}

async function mutateLocalFile(file, fallback, mutate) {
  const operation = localWriteQueue.then(async () => {
    const current = await readLocalFile(file, fallback)
    const { value, result } = mutate(current)
    await mkdir(dataDirectory, { recursive: true })
    const target = path.join(dataDirectory, file)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, target)
    return result
  })
  localWriteQueue = operation.catch(() => {})
  return operation
}

async function initializeStorage() {
  if (pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS menu_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('starter', 'main', 'dessert', 'drink')),
        price INTEGER NOT NULL CHECK (price >= 0),
        description TEXT NOT NULL,
        image TEXT NOT NULL,
        available BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        guests TEXT NOT NULL,
        date DATE NOT NULL,
        time TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'done')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL
      )
    `)
    const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM menu_items')
    if (rows[0].count === 0) {
      for (const dish of defaultDishes) {
        await pool.query(
          `INSERT INTO menu_items (id, name, category, price, description, image, available)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [dish.id, dish.name, dish.category, dish.price, dish.description, dish.image, dish.available],
        )
      }
    }
    return
  }

  const [menu, bookings] = await Promise.all([
    readLocalFile('menu.json', null),
    readLocalFile('bookings.json', []),
  ])
  if (menu === null) await writeLocalFile('menu.json', defaultDishes)
  if (!Array.isArray(bookings)) throw new Error('data/bookings.json must contain a JSON array.')
  if (menu !== null && !Array.isArray(menu)) throw new Error('data/menu.json must contain a JSON array.')
}

async function listMenu(includeUnavailable = false) {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT id, name, category, price, description, image, available
       FROM menu_items ${includeUnavailable ? '' : 'WHERE available = TRUE'}
       ORDER BY created_at, id`,
    )
    return rows.map(mapDish)
  }
  const dishes = await readLocalFile('menu.json', defaultDishes)
  return dishes.filter((dish) => includeUnavailable || dish.available)
}

async function saveDish(dish, id = randomUUID()) {
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO menu_items (id, name, category, price, description, image, available)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)
       RETURNING id, name, category, price, description, image, available`,
      [id, dish.name, dish.category, dish.price, dish.description, dish.image],
    )
    return mapDish(rows[0])
  }
  return mutateLocalFile('menu.json', defaultDishes, (dishes) => {
    const created = { id, ...dish, available: true }
    return { value: [...dishes, created], result: created }
  })
}

async function updateDish(id, dish) {
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE menu_items
       SET name = $2, category = $3, price = $4, description = $5, image = $6
       WHERE id = $1
       RETURNING id, name, category, price, description, image, available`,
      [id, dish.name, dish.category, dish.price, dish.description, dish.image],
    )
    return rows[0] ? mapDish(rows[0]) : null
  }
  return mutateLocalFile('menu.json', defaultDishes, (dishes) => {
    const index = dishes.findIndex((item) => item.id === id)
    if (index === -1) return { value: dishes, result: null }
    dishes[index] = { ...dishes[index], ...dish }
    return { value: dishes, result: dishes[index] }
  })
}

async function changeAvailability(id, available) {
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE menu_items SET available = $2
       WHERE id = $1
       RETURNING id, name, category, price, description, image, available`,
      [id, available],
    )
    return rows[0] ? mapDish(rows[0]) : null
  }
  return mutateLocalFile('menu.json', defaultDishes, (dishes) => {
    const dish = dishes.find((item) => item.id === id)
    if (!dish) return { value: dishes, result: null }
    dish.available = available
    return { value: dishes, result: dish }
  })
}

async function deleteDish(id) {
  if (pool) {
    const { rowCount } = await pool.query('DELETE FROM menu_items WHERE id = $1', [id])
    return rowCount > 0
  }
  return mutateLocalFile('menu.json', defaultDishes, (dishes) => {
    const remaining = dishes.filter((item) => item.id !== id)
    return { value: remaining, result: remaining.length !== dishes.length }
  })
}

async function createBooking(booking) {
  const id = randomUUID()
  if (pool) {
    const { rows } = await pool.query(
      `INSERT INTO bookings (id, name, phone, guests, date, time, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, phone, guests, date::text AS date, time, note, status, created_at`,
      [id, booking.name, booking.phone, booking.guests, booking.date, booking.time, booking.note],
    )
    return mapBooking(rows[0])
  }
  return mutateLocalFile('bookings.json', [], (bookings) => {
    const created = { id, ...booking, status: 'new', createdAt: new Date().toISOString() }
    return { value: [...bookings, created], result: created }
  })
}

async function listBookings() {
  if (pool) {
    const { rows } = await pool.query(
      `SELECT id, name, phone, guests, date::text AS date, time, note, status, created_at
       FROM bookings ORDER BY created_at DESC`,
    )
    return rows.map(mapBooking)
  }
  return (await readLocalFile('bookings.json', [])).sort(
    (left, right) => new Date(right.createdAt) - new Date(left.createdAt),
  )
}

async function toggleBookingStatus(id) {
  if (pool) {
    const { rows } = await pool.query(
      `UPDATE bookings SET status = CASE WHEN status = 'done' THEN 'new' ELSE 'done' END
       WHERE id = $1
       RETURNING id`,
      [id],
    )
    return rows.length > 0
  }
  return mutateLocalFile('bookings.json', [], (bookings) => {
    const booking = bookings.find((item) => item.id === id)
    if (!booking) return { value: bookings, result: false }
    booking.status = booking.status === 'done' ? 'new' : 'done'
    return { value: bookings, result: true }
  })
}

async function createSession(token, expiresAt) {
  const tokenHash = hash(token)
  if (pool) {
    await pool.query(
      `INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, $2)
       ON CONFLICT (token_hash) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [tokenHash, new Date(expiresAt)],
    )
    await pool.query('DELETE FROM admin_sessions WHERE expires_at <= NOW()')
    return
  }
  localSessions.set(tokenHash, expiresAt)
  for (const [key, expiry] of localSessions) {
    if (expiry <= Date.now()) localSessions.delete(key)
  }
}

async function hasSession(token) {
  const tokenHash = hash(token)
  if (pool) {
    const { rowCount } = await pool.query(
      'SELECT 1 FROM admin_sessions WHERE token_hash = $1 AND expires_at > NOW()',
      [tokenHash],
    )
    return rowCount > 0
  }
  const expiresAt = localSessions.get(tokenHash)
  if (!expiresAt || expiresAt <= Date.now()) {
    localSessions.delete(tokenHash)
    return false
  }
  return true
}

async function deleteSession(token) {
  if (pool) {
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hash(token)])
    return
  }
  localSessions.delete(hash(token))
}

function getSessionToken(request) {
  const cookie = request.headers.cookie
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))
  if (!cookie) return null
  const value = cookie.slice(sessionCookie.length + 1)
  const separator = value.lastIndexOf('.')
  if (separator < 1) return null
  const id = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  return safeEqual(signSession(id), signature) ? id : null
}

function setSessionCookie(response, token, maxAge) {
  const value = token ? `${token}.${signSession(token)}` : ''
  const attributes = [
    `${sessionCookie}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ]
  if (isProduction) attributes.push('Secure')
  response.setHeader('Set-Cookie', attributes.join('; '))
}

function sendJson(response, status, data, headers = {}) {
  const body = JSON.stringify(data)
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  response.end(body)
}

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] || ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Ожидался JSON-запрос.'), { status: 415 })
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > maxRequestBytes) {
      throw Object.assign(new Error('Слишком большой запрос.'), { status: 413 })
    }
    chunks.push(chunk)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Expected object')
    return value
  } catch {
    throw Object.assign(new Error('Некорректный JSON-запрос.'), { status: 400 })
  }
}

function validateDish(body) {
  const categories = ['starter', 'main', 'dessert', 'drink']
  const dish = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    category: body.category,
    price: body.price,
    description: typeof body.description === 'string' ? body.description.trim() : '',
    image: typeof body.image === 'string' ? body.image.trim() : '',
  }
  let imageUrl
  try {
    imageUrl = new URL(dish.image)
  } catch {
    imageUrl = null
  }
  if (
    !dish.name
    || dish.name.length > 70
    || !categories.includes(dish.category)
    || !Number.isSafeInteger(dish.price)
    || dish.price < 0
    || !dish.description
    || dish.description.length > 180
    || imageUrl?.protocol !== 'https:'
  ) {
    throw Object.assign(new Error('Проверьте название, категорию, цену, описание и HTTPS-ссылку на фото.'), { status: 400 })
  }
  return dish
}

function validateBooking(body) {
  const booking = {
    name: typeof body.name === 'string' ? body.name.trim() : '',
    phone: typeof body.phone === 'string' ? body.phone.trim() : '',
    guests: typeof body.guests === 'string' ? body.guests.trim() : '',
    date: typeof body.date === 'string' ? body.date : '',
    time: typeof body.time === 'string' ? body.time : '',
    note: typeof body.note === 'string' ? body.note.trim() : '',
  }
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(booking.date)
    && !Number.isNaN(Date.parse(`${booking.date}T00:00:00Z`))
    && new Date(`${booking.date}T00:00:00Z`).toISOString().slice(0, 10) === booking.date
  const validTime = /^(?:[01]\d|2[0-2]):[0-5]\d$/.test(booking.time)
  const validGuests = ['1 гость', '2 гостя', '3 гостя', '4 гостя', '5 гостей', '6 гостей', '7 и более']
    .includes(booking.guests)
  const invalidFields = []
  if (!booking.name || booking.name.length > 100) invalidFields.push('имя')
  if (!booking.phone || booking.phone.length > 40) invalidFields.push('телефон')
  if (!validGuests) invalidFields.push('число гостей')
  if (!validDate || booking.date < dateInBishkek()) invalidFields.push('дата')
  if (!validTime) invalidFields.push('время')
  if (booking.note.length > 500) invalidFields.push('пожелания')
  if (invalidFields.length > 0) {
    throw Object.assign(new Error(`Проверьте поля: ${invalidFields.join(', ')}.`), { status: 400 })
  }
  return booking
}

function loginRateLimit(request) {
  if (!isProduction) return false
  const ip = request.headers['x-forwarded-for']?.split(',')[0].trim()
    || request.socket.remoteAddress
    || 'unknown'
  const now = Date.now()
  const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < rateLimitWindowMs)
  if (attempts.length >= maxLoginAttempts) {
    loginAttempts.set(ip, attempts)
    return true
  }
  attempts.push(now)
  loginAttempts.set(ip, attempts)
  return false
}

async function handleApi(request, response, url) {
  const { pathname } = url
  const method = request.method

  if (method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { status: 'ok' })
    return true
  }

  if (method === 'GET' && pathname === '/api/menu') {
    sendJson(response, 200, { dishes: await listMenu() })
    return true
  }

  if (method === 'POST' && pathname === '/api/bookings') {
    const booking = validateBooking(await readJsonBody(request))
    await createBooking(booking)
    sendJson(response, 201, { ok: true })
    return true
  }

  if (pathname.startsWith('/api/admin/')) {
    const token = getSessionToken(request)
    const authenticated = token ? await hasSession(token) : false

    if (method === 'GET' && pathname === '/api/admin/session') {
      sendJson(response, 200, { authenticated })
      return true
    }

    if (method === 'POST' && pathname === '/api/admin/login') {
      if (loginRateLimit(request)) {
        sendJson(response, 429, { error: 'Слишком много попыток входа. Попробуйте позже.' })
        return true
      }
      const body = await readJsonBody(request)
      const loginMatches = typeof body.login === 'string' && safeEqual(body.login, adminLogin)
      const passwordMatches = typeof body.password === 'string' && safeEqual(body.password, adminPassword)
      if (!loginMatches || !passwordMatches) {
        sendJson(response, 401, { error: 'Неверный логин или пароль.' })
        return true
      }
      const sessionId = randomBytes(32).toString('hex')
      await createSession(sessionId, Date.now() + sessionLifetimeMs)
      setSessionCookie(response, sessionId, Math.floor(sessionLifetimeMs / 1000))
      sendJson(response, 200, { ok: true })
      return true
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
      if (token) await deleteSession(token)
      setSessionCookie(response, null, 0)
      sendJson(response, 200, { ok: true })
      return true
    }

    if (!authenticated) {
      sendJson(response, 401, { error: 'Необходим вход в админку.' })
      return true
    }

    if (method === 'GET' && pathname === '/api/admin/menu') {
      sendJson(response, 200, { dishes: await listMenu(true) })
      return true
    }

    if (method === 'GET' && pathname === '/api/admin/bookings') {
      sendJson(response, 200, { bookings: await listBookings() })
      return true
    }

    if (method === 'POST' && pathname === '/api/admin/menu') {
      const dish = validateDish(await readJsonBody(request))
      sendJson(response, 201, { dish: await saveDish(dish) })
      return true
    }

    const bookingStatusMatch = pathname.match(/^\/api\/admin\/bookings\/([^/]+)\/status$/)
    if (method === 'PATCH' && bookingStatusMatch) {
      const id = decodeURIComponent(bookingStatusMatch[1])
      if (!await toggleBookingStatus(id)) {
        sendJson(response, 404, { error: 'Заявка не найдена.' })
        return true
      }
      sendJson(response, 200, { ok: true })
      return true
    }

    const availabilityMatch = pathname.match(/^\/api\/admin\/menu\/([^/]+)\/availability$/)
    if (method === 'PATCH' && availabilityMatch) {
      const id = decodeURIComponent(availabilityMatch[1])
      const body = await readJsonBody(request)
      if (typeof body.available !== 'boolean') {
        sendJson(response, 400, { error: 'Некорректный статус публикации.' })
        return true
      }
      const dish = await changeAvailability(id, body.available)
      if (!dish) {
        sendJson(response, 404, { error: 'Блюдо не найдено.' })
        return true
      }
      sendJson(response, 200, { dish })
      return true
    }

    const dishMatch = pathname.match(/^\/api\/admin\/menu\/([^/]+)$/)
    if (dishMatch) {
      const id = decodeURIComponent(dishMatch[1])
      if (method === 'PATCH') {
        const dish = await updateDish(id, validateDish(await readJsonBody(request)))
        if (!dish) {
          sendJson(response, 404, { error: 'Блюдо не найдено.' })
          return true
        }
        sendJson(response, 200, { dish })
        return true
      }
      if (method === 'DELETE') {
        if (!await deleteDish(id)) {
          sendJson(response, 404, { error: 'Блюдо не найдено.' })
          return true
        }
        sendJson(response, 200, { ok: true })
        return true
      }
    }
  }

  if (pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API-маршрут не найден.' })
    return true
  }
  return false
}

async function serveStatic(request, response, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Метод не поддерживается.' }, { Allow: 'GET, HEAD' })
    return
  }

  let requestedPath
  try {
    requestedPath = decodeURIComponent(url.pathname)
  } catch {
    sendJson(response, 400, { error: 'Некорректный адрес.' })
    return
  }

  const distDirectory = path.join(root, 'dist')
  const resolvedPath = path.resolve(distDirectory, `.${requestedPath}`)
  if (resolvedPath !== distDirectory && !resolvedPath.startsWith(`${distDirectory}${path.sep}`)) {
    sendJson(response, 400, { error: 'Некорректный адрес.' })
    return
  }

  let file = resolvedPath
  try {
    try {
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (path.extname(requestedPath)) {
        sendJson(response, 404, { error: 'Файл не найден.' })
        return
      }
      file = path.join(distDirectory, 'index.html')
    }
    const content = await readFile(file)
    const extension = path.extname(file)
    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(request.method === 'HEAD' ? undefined : content)
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendJson(response, 503, { error: 'Сайт ещё не собран. Выполните npm run build.' })
      return
    }
    throw error
  }
}

async function start() {
  await initializeStorage()

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite')
    vite = await createViteServer({
      appType: 'spa',
      server: { middlewareMode: true },
    })
  }

  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
      if (await handleApi(request, response, url)) return
      if (vite) {
        vite.middlewares(request, response, (error) => {
          if (error) {
            console.error('Vite request failed:', error)
            if (!response.headersSent) sendJson(response, 500, { error: 'Ошибка сервера.' })
          }
        })
        return
      }
      await serveStatic(request, response, url)
    } catch (error) {
      if (error.status) {
        sendJson(response, error.status, { error: error.message })
        return
      }
      console.error('Request failed:', error)
      if (!response.headersSent) sendJson(response, 500, { error: 'Внутренняя ошибка сервера.' })
      else response.destroy()
    }
  })

  server.listen(port, process.env.HOST || '0.0.0.0', () => {
    console.log(`Borcelle server listening on port ${port}`)
  })

  const shutdown = async () => {
    server.close(async () => {
      if (vite) await vite.close()
      if (pool) await pool.end()
      process.exit(0)
    })
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

start().catch(async (error) => {
  console.error('Could not start Borcelle server:', error)
  if (pool) await pool.end()
  process.exitCode = 1
})
