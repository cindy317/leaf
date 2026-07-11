// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// ---------- 初始化数据库 ----------
// ---------- 初始化数据库 ----------
const db = new sqlite3.Database('./data.db', (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
    process.exit(1);
  }
  console.log('数据库连接成功');
});

// 创建表（如果不存在）
db.run(`
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    answer TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`, (err) => {
  if (err) {
    console.error('创建表失败:', err.message);
    process.exit(1);
  }
  console.log('表已准备就绪');

  // 检查是否需要插入示例数据
  db.get(`SELECT COUNT(*) as count FROM questions`, (err, row) => {
    if (err) {
      console.error('查询数据失败:', err.message);
      return;
    }
    if (row && row.count === 0) {
      const samples = [
        ['计算机专业对数学要求有多高？', '线代和概率论是核心，离散数学也很重要。但实际开发中，数学更多是培养逻辑，不用太担心，勤练习就好。'],
        ['机械工程就业前景怎么样？', '非常广！汽车、机器人、航空航天都需要。建议多学一些控制或编程，复合型人才更受欢迎。'],
        ['经济学是不是很难找到对口工作？', '不会。银行、咨询、互联网都需要经济背景。关键是把理论用在数据分析上，考一些 CFA 或 FRM 是加分项。']
      ];
      const stmt = db.prepare(`INSERT INTO questions (content, answer) VALUES (?, ?)`);
      samples.forEach(([q, a]) => stmt.run(q, a));
      stmt.finalize();
      console.log('已插入示例数据');
    } else {
      console.log(`已有 ${row ? row.count : 0} 条数据，跳过插入`);
    }
  });
});

// ---------- 初始化 DeepSeek 客户端 ----------
const client = new OpenAI({
  baseURL: 'https://api.deepseek.com/v1',
  apiKey: process.env.DEEPSEEK_API_KEY,
});

// ---------- API 路由 ----------

// 1. 获取所有问答
app.get('/api/questions', (req, res) => {
  db.all(`SELECT * FROM questions ORDER BY created_at DESC`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// 2. 发布新问题（暂不包含回答）
app.post('/api/questions', (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: '内容不能为空' });
  db.run(`INSERT INTO questions (content) VALUES (?)`, [content], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, content, answer: null, created_at: new Date() });
  });
});

// 3. AI 专业推荐
app.post('/api/recommend', async (req, res) => {
  const { tags } = req.body; // 期望 tags 为字符串数组，如 ['编程', 'AI']
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
      model: 'deepseek-chat', // 或 'deepseek-v4-flash'
      messages: [
        { role: 'system', content: '你是一个专业选择顾问，擅长根据兴趣推荐大学专业。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' } // 强制返回 JSON（DeepSeek 支持）
    });

    const result = JSON.parse(response.choices[0].message.content);
    // 如果返回的是对象，可能包含 key，我们尝试提取数组
    let recommendations = [];
    if (Array.isArray(result)) {
      recommendations = result;
    } else if (result.recommendations && Array.isArray(result.recommendations)) {
      recommendations = result.recommendations;
    } else {
      // 尝试将对象转为数组
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