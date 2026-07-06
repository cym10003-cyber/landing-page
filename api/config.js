export default function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.status(200).json({
    github_token: (process.env.GITHUB_TOKEN || "").trim(),
    admin_password: process.env.ADMIN_PASSWORD || "admin1234"
  });
}
