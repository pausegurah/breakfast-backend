function getBasicAuthHeader() {
  const user = process.env.ULYSSES_USER;
  const pass = process.env.ULYSSES_PASS;
  const token = Buffer.from(`${user}:${pass}`).toString('base64');
  return `Basic ${token}`;
}

module.exports = { getBasicAuthHeader };
