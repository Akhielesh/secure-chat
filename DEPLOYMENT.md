# 🚀 Production Deployment Guide

## Pre-Deployment Checklist

### 1. Environment Variables Setup
Copy `.env.production.template` to `.env.production` and fill in all values:

```bash
cp .env.production.template .env.production
```

**Critical Variables to Set:**
- `JWT_SECRET` - Generate a 64+ character random string
- `DATABASE_URL` - Your PostgreSQL connection string
- `ALLOWED_ORIGINS` - Your domain(s) in JSON array format
- `SOCKET_ALLOWED_ORIGINS` - Same as ALLOWED_ORIGINS for Socket.IO
- `REDIS_URL` - Your Redis connection string (optional but recommended)
- `R2_*` - Cloudflare R2 credentials for file storage

### 2. Database Setup
Ensure your PostgreSQL database is ready:

```bash
# Generate Prisma client
npm run prisma:generate

# Deploy migrations
npm run prisma:migrate:deploy
```

### 3. Security Checklist
- ✅ JWT_SECRET is set to a secure random value
- ✅ CORS origins are set to your actual domain(s)
- ✅ Rate limiting is enabled (120 req/min global, 5 auth/15min)
- ✅ Request body size limited to 200kb
- ✅ Running on HTTPS (handled by hosting platform)

## Deployment Options

### Option 1: Render.com (Recommended)
1. Push code to GitHub
2. Connect Render to your GitHub repository
3. Use the provided `render.yaml` configuration
4. Set environment variables in Render dashboard
5. Deploy!

**Monthly Cost:** ~$14 (Web Service $7 + Database $7)

### Option 2: Railway
```bash
npm install -g @railway/cli
railway login
railway init
railway add postgresql
railway deploy
```

### Option 3: Docker Deployment
```bash
# Build the image
docker build -t secure-chat .

# Run with environment file
docker run -d --env-file .env.production -p 3000:3000 secure-chat
```

## Free Service Recommendations

### Database: Neon.tech or Supabase
- **Neon**: 0.5GB free, excellent for your scale
- **Supabase**: 500MB free, includes real-time features

### Redis: Upstash
- 10,000 commands/day free
- Perfect for session storage and Socket.IO scaling

### File Storage: Cloudflare R2
- 10GB free storage
- 1 million requests/month free
- Much cheaper than AWS S3

### Domain: Cloudflare
- Free SSL certificates
- Global CDN
- DNS management

## Production Monitoring

### Health Checks
- `/health` - Simple health check
- `/healthz` - Detailed health with response time
- `/health/db` - Database connectivity check

### Metrics
- Prometheus metrics available at `/metrics`
- Requires basic auth (set METRICS_USER and METRICS_PASS)

### Logging
- Structured JSON logging with Pino
- Set LOG_LEVEL=info for production

## Scaling Considerations

### For 2-50 Users
- Single instance with Render Starter plan ($7/month)
- Basic PostgreSQL database
- No Redis required yet

### For 50-100 Users
- Add Redis for session storage and Socket.IO scaling
- Consider upgrading database plan
- Monitor response times and add caching if needed

### For 100+ Users
- Enable Redis adapter for Socket.IO
- Consider horizontal scaling (multiple instances)
- Add database read replicas if needed

## Security Best Practices

1. **Never commit secrets** - Use environment variables
2. **Enable HTTPS** - Hosting platforms handle this automatically
3. **Set secure cookies** - CROSS_SITE=true for different domains
4. **Monitor rate limits** - Check for abuse patterns
5. **Regular updates** - Keep dependencies updated
6. **Database backups** - Enable automatic backups on your hosting platform

## Troubleshooting

### Common Issues

**CORS Errors:**
- Check ALLOWED_ORIGINS and SOCKET_ALLOWED_ORIGINS match your domain
- Ensure CROSS_SITE=true if frontend/backend are on different domains

**Database Connection Errors:**
- Verify DATABASE_URL is correct
- Check if database allows external connections
- Ensure SSL is enabled (?sslmode=require)

**Socket.IO Connection Issues:**
- Check SOCKET_ALLOWED_ORIGINS
- Verify WebSocket support on hosting platform
- Test with different browsers

**File Upload Issues:**
- Verify R2 credentials are correct
- Check bucket permissions
- Ensure CORS is configured on R2 bucket

## Post-Deployment

1. **Test all functionality**
   - User registration/login
   - Real-time messaging
   - File uploads
   - Multiple browser sessions

2. **Monitor performance**
   - Check response times
   - Monitor error rates
   - Watch resource usage

3. **Set up alerts**
   - Database connection failures
   - High error rates
   - Resource exhaustion

## Support

For deployment issues:
1. Check application logs
2. Verify all environment variables are set
3. Test database connectivity
4. Check CORS configuration

Remember: Start simple with a single instance and scale up as needed!
