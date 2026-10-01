// Magnusim CAD kernel facade: minimal JSON value, parser and writer.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace mk {

struct InputError : std::runtime_error {
  explicit InputError(const std::string& m) : std::runtime_error(m) {}
};

class JV {
public:
  enum Type { NUL, BOOL, NUM, STR, ARR, OBJ };

  JV() : t_(NUL) {}
  JV(std::nullptr_t) : t_(NUL) {}
  JV(bool b) : t_(BOOL), b_(b) {}
  JV(int n) : t_(NUM), n_(n) {}
  JV(unsigned n) : t_(NUM), n_(n) {}
  JV(long n) : t_(NUM), n_((double)n) {}
  JV(unsigned long n) : t_(NUM), n_((double)n) {}
  JV(long long n) : t_(NUM), n_((double)n) {}
  JV(unsigned long long n) : t_(NUM), n_((double)n) {}
  JV(double n) : t_(NUM), n_(n) {}
  JV(const char* s) : t_(STR), s_(s) {}
  JV(const std::string& s) : t_(STR), s_(s) {}
  JV(std::string&& s) : t_(STR), s_(std::move(s)) {}

  static JV arr() { JV v; v.t_ = ARR; return v; }
  static JV obj() { JV v; v.t_ = OBJ; return v; }

  Type type() const { return t_; }
  bool isNull() const { return t_ == NUL; }
  bool isNum() const { return t_ == NUM; }
  bool isStr() const { return t_ == STR; }
  bool isArr() const { return t_ == ARR; }
  bool isObj() const { return t_ == OBJ; }
  bool isBool() const { return t_ == BOOL; }

  double num() const {
    if (t_ != NUM) throw InputError("expected a number");
    return n_;
  }
  bool boolean() const {
    if (t_ != BOOL) throw InputError("expected a boolean");
    return b_;
  }
  const std::string& str() const {
    if (t_ != STR) throw InputError("expected a string");
    return s_;
  }
  const std::vector<JV>& items() const {
    if (t_ != ARR) throw InputError("expected an array");
    return a_;
  }
  size_t size() const { return t_ == ARR ? a_.size() : (t_ == OBJ ? o_.size() : 0); }
  const JV& operator[](size_t i) const {
    if (t_ != ARR || i >= a_.size()) throw InputError("array index out of range");
    return a_[i];
  }
  const std::vector<std::pair<std::string, JV>>& members() const {
    if (t_ != OBJ) throw InputError("expected an object");
    return o_;
  }

  // Object lookup (nullptr when missing or not an object).
  const JV* get(const std::string& k) const {
    if (t_ != OBJ) return nullptr;
    for (auto& kv : o_)
      if (kv.first == k) return &kv.second;
    return nullptr;
  }
  bool has(const std::string& k) const {
    const JV* v = get(k);
    return v && !v->isNull();
  }
  const JV& req(const std::string& k) const {
    const JV* v = get(k);
    if (!v || v->isNull()) throw InputError("missing parameter '" + k + "'");
    return *v;
  }
  double num(const std::string& k) const {
    const JV& v = req(k);
    if (!v.isNum()) throw InputError("parameter '" + k + "' must be a number");
    return v.n_;
  }
  double num(const std::string& k, double def) const {
    const JV* v = get(k);
    if (!v || v->isNull()) return def;
    if (!v->isNum()) throw InputError("parameter '" + k + "' must be a number");
    return v->n_;
  }
  bool boolean(const std::string& k, bool def) const {
    const JV* v = get(k);
    if (!v || v->isNull()) return def;
    if (!v->isBool()) throw InputError("parameter '" + k + "' must be a boolean");
    return v->b_;
  }
  std::string str(const std::string& k) const {
    const JV& v = req(k);
    if (!v.isStr()) throw InputError("parameter '" + k + "' must be a string");
    return v.s_;
  }
  std::string str(const std::string& k, const std::string& def) const {
    const JV* v = get(k);
    if (!v || v->isNull()) return def;
    if (!v->isStr()) throw InputError("parameter '" + k + "' must be a string");
    return v->s_;
  }

  // Builders.
  JV& push(JV v) {
    if (t_ == NUL) t_ = ARR;
    a_.push_back(std::move(v));
    return a_.back();
  }
  JV& set(const std::string& k, JV v) {
    if (t_ == NUL) t_ = OBJ;
    for (auto& kv : o_)
      if (kv.first == k) {
        kv.second = std::move(v);
        return kv.second;
      }
    o_.emplace_back(k, std::move(v));
    return o_.back().second;
  }
  JV& mut(const std::string& k) {
    if (t_ == NUL) t_ = OBJ;
    for (auto& kv : o_)
      if (kv.first == k) return kv.second;
    o_.emplace_back(k, JV());
    return o_.back().second;
  }
  std::vector<JV>& mutItems() {
    if (t_ == NUL) t_ = ARR;
    return a_;
  }

  void write(std::string& out) const {
    switch (t_) {
      case NUL: out += "null"; break;
      case BOOL: out += b_ ? "true" : "false"; break;
      case NUM: writeNum(out, n_); break;
      case STR: writeStr(out, s_); break;
      case ARR: {
        out += '[';
        for (size_t i = 0; i < a_.size(); ++i) {
          if (i) out += ',';
          a_[i].write(out);
        }
        out += ']';
        break;
      }
      case OBJ: {
        out += '{';
        for (size_t i = 0; i < o_.size(); ++i) {
          if (i) out += ',';
          writeStr(out, o_[i].first);
          out += ':';
          o_[i].second.write(out);
        }
        out += '}';
        break;
      }
    }
  }
  std::string dump() const {
    std::string s;
    write(s);
    return s;
  }

  static void writeNum(std::string& out, double d) {
    if (!std::isfinite(d)) {
      out += "null";
      return;
    }
    if (d == std::floor(d) && std::fabs(d) < 9.007199254740992e15) {
      char buf[32];
      snprintf(buf, sizeof buf, "%lld", (long long)d);
      out += buf;
      return;
    }
    char buf[40];
    snprintf(buf, sizeof buf, "%.17g", d);
    out += buf;
  }
  static void writeStr(std::string& out, const std::string& s) {
    out += '"';
    for (unsigned char c : s) {
      switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
          if (c < 0x20) {
            char buf[8];
            snprintf(buf, sizeof buf, "\\u%04x", c);
            out += buf;
          } else {
            out += (char)c;
          }
      }
    }
    out += '"';
  }

  static JV parse(const char* text) {
    Parser p{text};
    p.ws();
    JV v = p.value(0);
    p.ws();
    if (*p.s) throw InputError("trailing characters after JSON value");
    return v;
  }

private:
  struct Parser {
    const char* s;
    void ws() {
      while (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r') ++s;
    }
    [[noreturn]] void fail(const char* what) { throw InputError(std::string("bad JSON: ") + what); }
    JV value(int depth) {
      if (depth > 200) fail("nesting too deep");
      ws();
      char c = *s;
      if (c == '{') return object(depth);
      if (c == '[') return array(depth);
      if (c == '"') return JV(string());
      if (c == 't' && !strncmp(s, "true", 4)) { s += 4; return JV(true); }
      if (c == 'f' && !strncmp(s, "false", 5)) { s += 5; return JV(false); }
      if (c == 'n' && !strncmp(s, "null", 4)) { s += 4; return JV(); }
      if (c == '-' || (c >= '0' && c <= '9')) return number();
      fail("unexpected character");
    }
    JV number() {
      char* end = nullptr;
      double d = strtod(s, &end);
      if (end == s) fail("bad number");
      s = end;
      return JV(d);
    }
    static void utf8(std::string& o, unsigned cp) {
      if (cp < 0x80) o += (char)cp;
      else if (cp < 0x800) { o += (char)(0xC0 | (cp >> 6)); o += (char)(0x80 | (cp & 0x3F)); }
      else if (cp < 0x10000) {
        o += (char)(0xE0 | (cp >> 12)); o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F));
      } else {
        o += (char)(0xF0 | (cp >> 18)); o += (char)(0x80 | ((cp >> 12) & 0x3F));
        o += (char)(0x80 | ((cp >> 6) & 0x3F)); o += (char)(0x80 | (cp & 0x3F));
      }
    }
    unsigned hex4() {
      unsigned v = 0;
      for (int i = 0; i < 4; ++i) {
        char c = *s++;
        v <<= 4;
        if (c >= '0' && c <= '9') v |= c - '0';
        else if (c >= 'a' && c <= 'f') v |= c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') v |= c - 'A' + 10;
        else fail("bad \\u escape");
      }
      return v;
    }
    std::string string() {
      ++s;  // opening quote
      std::string o;
      for (;;) {
        char c = *s++;
        if (c == '"') break;
        if (!c) fail("unterminated string");
        if (c == '\\') {
          char e = *s++;
          switch (e) {
            case '"': o += '"'; break;
            case '\\': o += '\\'; break;
            case '/': o += '/'; break;
            case 'b': o += '\b'; break;
            case 'f': o += '\f'; break;
            case 'n': o += '\n'; break;
            case 'r': o += '\r'; break;
            case 't': o += '\t'; break;
            case 'u': {
              unsigned cp = hex4();
              if (cp >= 0xD800 && cp < 0xDC00 && s[0] == '\\' && s[1] == 'u') {
                s += 2;
                unsigned lo = hex4();
                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
              }
              utf8(o, cp);
              break;
            }
            default: fail("bad escape");
          }
        } else {
          o += c;
        }
      }
      return o;
    }
    JV array(int depth) {
      ++s;
      JV v = JV::arr();
      ws();
      if (*s == ']') { ++s; return v; }
      for (;;) {
        v.push(value(depth + 1));
        ws();
        if (*s == ',') { ++s; continue; }
        if (*s == ']') { ++s; break; }
        fail("expected , or ]");
      }
      return v;
    }
    JV object(int depth) {
      ++s;
      JV v = JV::obj();
      ws();
      if (*s == '}') { ++s; return v; }
      for (;;) {
        ws();
        if (*s != '"') fail("expected key");
        std::string k = string();
        ws();
        if (*s != ':') fail("expected :");
        ++s;
        v.set(k, value(depth + 1));
        ws();
        if (*s == ',') { ++s; continue; }
        if (*s == '}') { ++s; break; }
        fail("expected , or }");
      }
      return v;
    }
  };

  Type t_;
  bool b_ = false;
  double n_ = 0;
  std::string s_;
  std::vector<JV> a_;
  std::vector<std::pair<std::string, JV>> o_;
};

inline JV vec3(double x, double y, double z) {
  JV a = JV::arr();
  a.push(x);
  a.push(y);
  a.push(z);
  return a;
}

}  // namespace mk
