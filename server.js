// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');  // 使用 pg 的 Pool 连接池
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// ---------- 连接 PostgreSQL ----------
// 从环境变量获取 DATABASE_URL（Render 会自动注入）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false  // Render 需要 SSL，但允许自签名证书
  }
});

// 测试连接
pool.connect((err) => {
  if (err) {
    console.error('PostgreSQL 连接失败:', err.message);
    process.exit(1);
  }
  console.log('PostgreSQL 连接成功');
});

// ---------- 初始化数据库表 ----------
async function initDatabase() {
  try {
    // 创建表（如果不存在）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        answer TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('表已准备就绪');

    // 检查是否需要插入示例数据
    const res = await pool.query('SELECT COUNT(*) FROM questions');
    const count = parseInt(res.rows[0].count, 10);
    if (count === 0) {
      const samples = [
        ['计算机专业对数学要求有多高？', '线代和概率论是核心，离散数学也很重要。但实际开发中，数学更多是培养逻辑，不用太担心，勤练习就好。'],
        ['机械工程就业前景怎么样？', '非常广！汽车、机器人、航空航天都需要。建议多学一些控制或编程，复合型人才更受欢迎。'],
        ['经济学是不是很难找到对口工作？', '不会。银行、咨询、互联网都需要经济背景。关键是把理论用在数据分析上，考一些 CFA 或 FRM 是加分项。']
      ];
      for (const [content, answer] of samples) {
        await pool.query(
          'INSERT INTO questions (content, answer) VALUES ($1, $2)',
          [content, answer]
        );
      }
      console.log('已插入示例数据');
    } else {
      console.log(`已有 ${count} 条数据，跳过插入`);
    }
  } catch (err) {
    console.error('初始化数据库失败:', err.message);
    process.exit(1);
  }
}

initDatabase();
console.log('🔑 DEEPSEEK_API_KEY 是否存在?', !!process.env.DEEPSEEK_API_KEY);

// ---------- 初始化 DeepSeek 客户端 ----------
const client = new OpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// ---------- API 路由 ----------

// 1. 获取所有问答
app.get('/api/questions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM questions ORDER BY created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. 发布新问题
app.post('/api/questions', async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  try {
    const result = await pool.query(
      'INSERT INTO questions (content) VALUES ($1) RETURNING id, content, answer, created_at',
      [content]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. AI 专业推荐
app.post('/api/recommend', async (req, res) => {
  const { tags } = req.body;
  if (!tags || tags.length === 0) {
    return res.status(400).json({ error: '请至少选择一个标签' });
  }

  try {
    const prompt = `
      用户对以下领域感兴趣：${tags.join('、')}。
      请根据这些兴趣，推荐 3~5 个大学专业，并简要说明推荐理由（每条理由不超过20字）。
      输出格式为 JSON 数组，每个元素包含专业名称和理由，例如：
      [{"major": "计算机科学与技术", "reason": "编程与AI的结合"}]
    `;

    const response = await client.chat.completions.create({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业选择顾问，擅长根据兴趣推荐大学专业。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content);
    let recommendations = [];
    if (Array.isArray(result)) {
      recommendations = result;
    } else if (result.recommendations && Array.isArray(result.recommendations)) {
      recommendations = result.recommendations;
    } else {
      recommendations = Object.values(result).filter(Array.isArray).flat() || [];
    }
    res.json({ recommendations });
  } catch (error) {
    console.error('AI 推荐失败:', error);
    res.status(500).json({ error: 'AI 服务暂时不可用，请稍后再试' });
  }
});

// 启动服务
app.listen(port, () => {
  console.log(`后端服务已启动：http://localhost:${port}`);
});