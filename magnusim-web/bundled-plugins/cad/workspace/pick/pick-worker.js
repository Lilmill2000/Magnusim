function Zs(f) {
  for (let t = f.length - 1; t >= 0; --t)
    if (f[t] >= 65535) return !0;
  return !1;
}
function hs(f) {
  return document.createElementNS("http://www.w3.org/1999/xhtml", f);
}
const ls = {};
function Ds(f) {
  const t = f[0];
  if (typeof t == "string" && t.startsWith("TSL:")) {
    const e = f[1];
    e && e.isStackTrace ? f[0] += " " + e.getLocation() : f[1] = 'Stack trace not available. Enable "THREE.Node.captureStackTrace" to capture stack traces.';
  }
  return f;
}
function pt(...f) {
  f = Ds(f);
  const t = "THREE." + f.shift();
  {
    const e = f[0];
    e && e.isStackTrace ? console.warn(e.getError(t)) : console.warn(t, ...f);
  }
}
function Yt(...f) {
  f = Ds(f);
  const t = "THREE." + f.shift();
  {
    const e = f[0];
    e && e.isStackTrace ? console.error(e.getError(t)) : console.error(t, ...f);
  }
}
function yi(...f) {
  const t = f.join(" ");
  t in ls || (ls[t] = !0, pt(...f));
}
class ci {
  /**
   * Adds the given event listener to the given event type.
   *
   * @param {string} type - The type of event to listen to.
   * @param {Function} listener - The function that gets called when the event is fired.
   */
  addEventListener(t, e) {
    this._listeners === void 0 && (this._listeners = {});
    const i = this._listeners;
    i[t] === void 0 && (i[t] = []), i[t].indexOf(e) === -1 && i[t].push(e);
  }
  /**
   * Returns `true` if the given event listener has been added to the given event type.
   *
   * @param {string} type - The type of event.
   * @param {Function} listener - The listener to check.
   * @return {boolean} Whether the given event listener has been added to the given event type.
   */
  hasEventListener(t, e) {
    const i = this._listeners;
    return i === void 0 ? !1 : i[t] !== void 0 && i[t].indexOf(e) !== -1;
  }
  /**
   * Removes the given event listener from the given event type.
   *
   * @param {string} type - The type of event.
   * @param {Function} listener - The listener to remove.
   */
  removeEventListener(t, e) {
    const i = this._listeners;
    if (i === void 0) return;
    const s = i[t];
    if (s !== void 0) {
      const n = s.indexOf(e);
      n !== -1 && s.splice(n, 1);
    }
  }
  /**
   * Dispatches an event object.
   *
   * @param {Object} event - The event that gets fired.
   */
  dispatchEvent(t) {
    const e = this._listeners;
    if (e === void 0) return;
    const i = e[t.type];
    if (i !== void 0) {
      t.target = this;
      const s = i.slice(0);
      for (let n = 0, r = s.length; n < r; n++)
        s[n].call(this, t);
      t.target = null;
    }
  }
}
const $ = ["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "0a", "0b", "0c", "0d", "0e", "0f", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "1a", "1b", "1c", "1d", "1e", "1f", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "2a", "2b", "2c", "2d", "2e", "2f", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39", "3a", "3b", "3c", "3d", "3e", "3f", "40", "41", "42", "43", "44", "45", "46", "47", "48", "49", "4a", "4b", "4c", "4d", "4e", "4f", "50", "51", "52", "53", "54", "55", "56", "57", "58", "59", "5a", "5b", "5c", "5d", "5e", "5f", "60", "61", "62", "63", "64", "65", "66", "67", "68", "69", "6a", "6b", "6c", "6d", "6e", "6f", "70", "71", "72", "73", "74", "75", "76", "77", "78", "79", "7a", "7b", "7c", "7d", "7e", "7f", "80", "81", "82", "83", "84", "85", "86", "87", "88", "89", "8a", "8b", "8c", "8d", "8e", "8f", "90", "91", "92", "93", "94", "95", "96", "97", "98", "99", "9a", "9b", "9c", "9d", "9e", "9f", "a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9", "aa", "ab", "ac", "ad", "ae", "af", "b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "ba", "bb", "bc", "bd", "be", "bf", "c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "ca", "cb", "cc", "cd", "ce", "cf", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "d8", "d9", "da", "db", "dc", "dd", "de", "df", "e0", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "ea", "eb", "ec", "ed", "ee", "ef", "f0", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "fa", "fb", "fc", "fd", "fe", "ff"];
function hi() {
  const f = Math.random() * 4294967295 | 0, t = Math.random() * 4294967295 | 0, e = Math.random() * 4294967295 | 0, i = Math.random() * 4294967295 | 0;
  return ($[f & 255] + $[f >> 8 & 255] + $[f >> 16 & 255] + $[f >> 24 & 255] + "-" + $[t & 255] + $[t >> 8 & 255] + "-" + $[t >> 16 & 15 | 64] + $[t >> 24 & 255] + "-" + $[e & 63 | 128] + $[e >> 8 & 255] + "-" + $[e >> 16 & 255] + $[e >> 24 & 255] + $[i & 255] + $[i >> 8 & 255] + $[i >> 16 & 255] + $[i >> 24 & 255]).toLowerCase();
}
function k(f, t, e) {
  return Math.max(t, Math.min(e, f));
}
function xe(f, t) {
  switch (t.constructor) {
    case Float32Array:
      return f;
    case Uint32Array:
      return f / 4294967295;
    case Uint16Array:
      return f / 65535;
    case Uint8Array:
    case Uint8ClampedArray:
      return f / 255;
    case Int32Array:
      return Math.max(f / 2147483647, -1);
    case Int16Array:
      return Math.max(f / 32767, -1);
    case Int8Array:
      return Math.max(f / 127, -1);
    default:
      throw new Error("THREE.MathUtils: Invalid component type.");
  }
}
function tt(f, t) {
  switch (t.constructor) {
    case Float32Array:
      return f;
    case Uint32Array:
      return Math.round(f * 4294967295);
    case Uint16Array:
      return Math.round(f * 65535);
    case Uint8Array:
    case Uint8ClampedArray:
      return Math.round(f * 255);
    case Int32Array:
      return Math.round(f * 2147483647);
    case Int16Array:
      return Math.round(f * 32767);
    case Int8Array:
      return Math.round(f * 127);
    default:
      throw new Error("THREE.MathUtils: Invalid component type.");
  }
}
class Z {
  static {
    Z.prototype.isVector2 = !0;
  }
  /**
   * Constructs a new 2D vector.
   *
   * @param {number} [x=0] - The x value of this vector.
   * @param {number} [y=0] - The y value of this vector.
   */
  constructor(t = 0, e = 0) {
    this.x = t, this.y = e;
  }
  /**
   * Alias for {@link Vector2#x}.
   *
   * @type {number}
   */
  get width() {
    return this.x;
  }
  set width(t) {
    this.x = t;
  }
  /**
   * Alias for {@link Vector2#y}.
   *
   * @type {number}
   */
  get height() {
    return this.y;
  }
  set height(t) {
    this.y = t;
  }
  /**
   * Sets the vector components.
   *
   * @param {number} x - The value of the x component.
   * @param {number} y - The value of the y component.
   * @return {Vector2} A reference to this vector.
   */
  set(t, e) {
    return this.x = t, this.y = e, this;
  }
  /**
   * Sets the vector components to the same value.
   *
   * @param {number} scalar - The value to set for all vector components.
   * @return {Vector2} A reference to this vector.
   */
  setScalar(t) {
    return this.x = t, this.y = t, this;
  }
  /**
   * Sets the vector's x component to the given value
   *
   * @param {number} x - The value to set.
   * @return {Vector2} A reference to this vector.
   */
  setX(t) {
    return this.x = t, this;
  }
  /**
   * Sets the vector's y component to the given value
   *
   * @param {number} y - The value to set.
   * @return {Vector2} A reference to this vector.
   */
  setY(t) {
    return this.y = t, this;
  }
  /**
   * Allows to set a vector component with an index.
   *
   * @param {number} index - The component index. `0` equals to x, `1` equals to y.
   * @param {number} value - The value to set.
   * @return {Vector2} A reference to this vector.
   */
  setComponent(t, e) {
    switch (t) {
      case 0:
        this.x = e;
        break;
      case 1:
        this.y = e;
        break;
      default:
        throw new Error("THREE.Vector2: index is out of range: " + t);
    }
    return this;
  }
  /**
   * Returns the value of the vector component which matches the given index.
   *
   * @param {number} index - The component index. `0` equals to x, `1` equals to y.
   * @return {number} A vector component value.
   */
  getComponent(t) {
    switch (t) {
      case 0:
        return this.x;
      case 1:
        return this.y;
      default:
        throw new Error("THREE.Vector2: index is out of range: " + t);
    }
  }
  /**
   * Returns a new vector with copied values from this instance.
   *
   * @return {Vector2} A clone of this instance.
   */
  clone() {
    return new this.constructor(this.x, this.y);
  }
  /**
   * Copies the values of the given vector to this instance.
   *
   * @param {Vector2} v - The vector to copy.
   * @return {Vector2} A reference to this vector.
   */
  copy(t) {
    return this.x = t.x, this.y = t.y, this;
  }
  /**
   * Adds the given vector to this instance.
   *
   * @param {Vector2} v - The vector to add.
   * @return {Vector2} A reference to this vector.
   */
  add(t) {
    return this.x += t.x, this.y += t.y, this;
  }
  /**
   * Adds the given scalar value to all components of this instance.
   *
   * @param {number} s - The scalar to add.
   * @return {Vector2} A reference to this vector.
   */
  addScalar(t) {
    return this.x += t, this.y += t, this;
  }
  /**
   * Adds the given vectors and stores the result in this instance.
   *
   * @param {Vector2} a - The first vector.
   * @param {Vector2} b - The second vector.
   * @return {Vector2} A reference to this vector.
   */
  addVectors(t, e) {
    return this.x = t.x + e.x, this.y = t.y + e.y, this;
  }
  /**
   * Adds the given vector scaled by the given factor to this instance.
   *
   * @param {Vector2} v - The vector.
   * @param {number} s - The factor that scales `v`.
   * @return {Vector2} A reference to this vector.
   */
  addScaledVector(t, e) {
    return this.x += t.x * e, this.y += t.y * e, this;
  }
  /**
   * Subtracts the given vector from this instance.
   *
   * @param {Vector2} v - The vector to subtract.
   * @return {Vector2} A reference to this vector.
   */
  sub(t) {
    return this.x -= t.x, this.y -= t.y, this;
  }
  /**
   * Subtracts the given scalar value from all components of this instance.
   *
   * @param {number} s - The scalar to subtract.
   * @return {Vector2} A reference to this vector.
   */
  subScalar(t) {
    return this.x -= t, this.y -= t, this;
  }
  /**
   * Subtracts the given vectors and stores the result in this instance.
   *
   * @param {Vector2} a - The first vector.
   * @param {Vector2} b - The second vector.
   * @return {Vector2} A reference to this vector.
   */
  subVectors(t, e) {
    return this.x = t.x - e.x, this.y = t.y - e.y, this;
  }
  /**
   * Multiplies the given vector with this instance.
   *
   * @param {Vector2} v - The vector to multiply.
   * @return {Vector2} A reference to this vector.
   */
  multiply(t) {
    return this.x *= t.x, this.y *= t.y, this;
  }
  /**
   * Multiplies the given scalar value with all components of this instance.
   *
   * @param {number} scalar - The scalar to multiply.
   * @return {Vector2} A reference to this vector.
   */
  multiplyScalar(t) {
    return this.x *= t, this.y *= t, this;
  }
  /**
   * Divides this instance by the given vector.
   *
   * @param {Vector2} v - The vector to divide.
   * @return {Vector2} A reference to this vector.
   */
  divide(t) {
    return this.x /= t.x, this.y /= t.y, this;
  }
  /**
   * Divides this vector by the given scalar.
   *
   * @param {number} scalar - The scalar to divide.
   * @return {Vector2} A reference to this vector.
   */
  divideScalar(t) {
    return this.multiplyScalar(1 / t);
  }
  /**
   * Multiplies this vector (with an implicit 1 as the 3rd component) by
   * the given 3x3 matrix.
   *
   * @param {Matrix3} m - The matrix to apply.
   * @return {Vector2} A reference to this vector.
   */
  applyMatrix3(t) {
    const e = this.x, i = this.y, s = t.elements;
    return this.x = s[0] * e + s[3] * i + s[6], this.y = s[1] * e + s[4] * i + s[7], this;
  }
  /**
   * If this vector's x or y value is greater than the given vector's x or y
   * value, replace that value with the corresponding min value.
   *
   * @param {Vector2} v - The vector.
   * @return {Vector2} A reference to this vector.
   */
  min(t) {
    return this.x = Math.min(this.x, t.x), this.y = Math.min(this.y, t.y), this;
  }
  /**
   * If this vector's x or y value is less than the given vector's x or y
   * value, replace that value with the corresponding max value.
   *
   * @param {Vector2} v - The vector.
   * @return {Vector2} A reference to this vector.
   */
  max(t) {
    return this.x = Math.max(this.x, t.x), this.y = Math.max(this.y, t.y), this;
  }
  /**
   * If this vector's x or y value is greater than the max vector's x or y
   * value, it is replaced by the corresponding value.
   * If this vector's x or y value is less than the min vector's x or y value,
   * it is replaced by the corresponding value.
   *
   * @param {Vector2} min - The minimum x and y values.
   * @param {Vector2} max - The maximum x and y values in the desired range.
   * @return {Vector2} A reference to this vector.
   */
  clamp(t, e) {
    return this.x = k(this.x, t.x, e.x), this.y = k(this.y, t.y, e.y), this;
  }
  /**
   * If this vector's x or y values are greater than the max value, they are
   * replaced by the max value.
   * If this vector's x or y values are less than the min value, they are
   * replaced by the min value.
   *
   * @param {number} minVal - The minimum value the components will be clamped to.
   * @param {number} maxVal - The maximum value the components will be clamped to.
   * @return {Vector2} A reference to this vector.
   */
  clampScalar(t, e) {
    return this.x = k(this.x, t, e), this.y = k(this.y, t, e), this;
  }
  /**
   * If this vector's length is greater than the max value, it is replaced by
   * the max value.
   * If this vector's length is less than the min value, it is replaced by the
   * min value.
   *
   * @param {number} min - The minimum value the vector length will be clamped to.
   * @param {number} max - The maximum value the vector length will be clamped to.
   * @return {Vector2} A reference to this vector.
   */
  clampLength(t, e) {
    const i = this.length();
    return this.divideScalar(i || 1).multiplyScalar(k(i, t, e));
  }
  /**
   * The components of this vector are rounded down to the nearest integer value.
   *
   * @return {Vector2} A reference to this vector.
   */
  floor() {
    return this.x = Math.floor(this.x), this.y = Math.floor(this.y), this;
  }
  /**
   * The components of this vector are rounded up to the nearest integer value.
   *
   * @return {Vector2} A reference to this vector.
   */
  ceil() {
    return this.x = Math.ceil(this.x), this.y = Math.ceil(this.y), this;
  }
  /**
   * The components of this vector are rounded to the nearest integer value
   *
   * @return {Vector2} A reference to this vector.
   */
  round() {
    return this.x = Math.round(this.x), this.y = Math.round(this.y), this;
  }
  /**
   * The components of this vector are rounded towards zero (up if negative,
   * down if positive) to an integer value.
   *
   * @return {Vector2} A reference to this vector.
   */
  roundToZero() {
    return this.x = Math.trunc(this.x), this.y = Math.trunc(this.y), this;
  }
  /**
   * Inverts this vector - i.e. sets x = -x and y = -y.
   *
   * @return {Vector2} A reference to this vector.
   */
  negate() {
    return this.x = -this.x, this.y = -this.y, this;
  }
  /**
   * Calculates the dot product of the given vector with this instance.
   *
   * @param {Vector2} v - The vector to compute the dot product with.
   * @return {number} The result of the dot product.
   */
  dot(t) {
    return this.x * t.x + this.y * t.y;
  }
  /**
   * Calculates the cross product of the given vector with this instance.
   *
   * @param {Vector2} v - The vector to compute the cross product with.
   * @return {number} The result of the cross product.
   */
  cross(t) {
    return this.x * t.y - this.y * t.x;
  }
  /**
   * Computes the square of the Euclidean length (straight-line length) from
   * (0, 0) to (x, y). If you are comparing the lengths of vectors, you should
   * compare the length squared instead as it is slightly more efficient to calculate.
   *
   * @return {number} The square length of this vector.
   */
  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }
  /**
   * Computes the  Euclidean length (straight-line length) from (0, 0) to (x, y).
   *
   * @return {number} The length of this vector.
   */
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y);
  }
  /**
   * Computes the Manhattan length of this vector.
   *
   * @return {number} The length of this vector.
   */
  manhattanLength() {
    return Math.abs(this.x) + Math.abs(this.y);
  }
  /**
   * Converts this vector to a unit vector - that is, sets it equal to a vector
   * with the same direction as this one, but with a vector length of `1`.
   *
   * @return {Vector2} A reference to this vector.
   */
  normalize() {
    return this.divideScalar(this.length() || 1);
  }
  /**
   * Computes the angle in radians of this vector with respect to the positive x-axis.
   *
   * @return {number} The angle in radians.
   */
  angle() {
    return Math.atan2(-this.y, -this.x) + Math.PI;
  }
  /**
   * Returns the angle between the given vector and this instance in radians.
   *
   * @param {Vector2} v - The vector to compute the angle with.
   * @return {number} The angle in radians.
   */
  angleTo(t) {
    const e = Math.sqrt(this.lengthSq() * t.lengthSq());
    if (e === 0) return Math.PI / 2;
    const i = this.dot(t) / e;
    return Math.acos(k(i, -1, 1));
  }
  /**
   * Computes the distance from the given vector to this instance.
   *
   * @param {Vector2} v - The vector to compute the distance to.
   * @return {number} The distance.
   */
  distanceTo(t) {
    return Math.sqrt(this.distanceToSquared(t));
  }
  /**
   * Computes the squared distance from the given vector to this instance.
   * If you are just comparing the distance with another distance, you should compare
   * the distance squared instead as it is slightly more efficient to calculate.
   *
   * @param {Vector2} v - The vector to compute the squared distance to.
   * @return {number} The squared distance.
   */
  distanceToSquared(t) {
    const e = this.x - t.x, i = this.y - t.y;
    return e * e + i * i;
  }
  /**
   * Computes the Manhattan distance from the given vector to this instance.
   *
   * @param {Vector2} v - The vector to compute the Manhattan distance to.
   * @return {number} The Manhattan distance.
   */
  manhattanDistanceTo(t) {
    return Math.abs(this.x - t.x) + Math.abs(this.y - t.y);
  }
  /**
   * Sets this vector to a vector with the same direction as this one, but
   * with the specified length.
   *
   * @param {number} length - The new length of this vector.
   * @return {Vector2} A reference to this vector.
   */
  setLength(t) {
    return this.normalize().multiplyScalar(t);
  }
  /**
   * Linearly interpolates between the given vector and this instance, where
   * alpha is the percent distance along the line - alpha = 0 will be this
   * vector, and alpha = 1 will be the given one.
   *
   * @param {Vector2} v - The vector to interpolate towards.
   * @param {number} alpha - The interpolation factor, typically in the closed interval `[0, 1]`.
   * @return {Vector2} A reference to this vector.
   */
  lerp(t, e) {
    return this.x += (t.x - this.x) * e, this.y += (t.y - this.y) * e, this;
  }
  /**
   * Linearly interpolates between the given vectors, where alpha is the percent
   * distance along the line - alpha = 0 will be first vector, and alpha = 1 will
   * be the second one. The result is stored in this instance.
   *
   * @param {Vector2} v1 - The first vector.
   * @param {Vector2} v2 - The second vector.
   * @param {number} alpha - The interpolation factor, typically in the closed interval `[0, 1]`.
   * @return {Vector2} A reference to this vector.
   */
  lerpVectors(t, e, i) {
    return this.x = t.x + (e.x - t.x) * i, this.y = t.y + (e.y - t.y) * i, this;
  }
  /**
   * Returns `true` if this vector is equal with the given one.
   *
   * @param {Vector2} v - The vector to test for equality.
   * @return {boolean} Whether this vector is equal with the given one.
   */
  equals(t) {
    return t.x === this.x && t.y === this.y;
  }
  /**
   * Sets this vector's x value to be `array[ offset ]` and y
   * value to be `array[ offset + 1 ]`.
   *
   * @param {Array<number>} array - An array holding the vector component values.
   * @param {number} [offset=0] - The offset into the array.
   * @return {Vector2} A reference to this vector.
   */
  fromArray(t, e = 0) {
    return this.x = t[e], this.y = t[e + 1], this;
  }
  /**
   * Writes the components of this vector to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number>} [array=[]] - The target array holding the vector components.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number>} The vector components.
   */
  toArray(t = [], e = 0) {
    return t[e] = this.x, t[e + 1] = this.y, t;
  }
  /**
   * Sets the components of this vector from the given buffer attribute.
   *
   * @param {BufferAttribute} attribute - The buffer attribute holding vector data.
   * @param {number} index - The index into the attribute.
   * @return {Vector2} A reference to this vector.
   */
  fromBufferAttribute(t, e) {
    return this.x = t.getX(e), this.y = t.getY(e), this;
  }
  /**
   * Rotates this vector around the given center by the given angle.
   *
   * @param {Vector2} center - The point around which to rotate.
   * @param {number} angle - The angle to rotate, in radians.
   * @return {Vector2} A reference to this vector.
   */
  rotateAround(t, e) {
    const i = Math.cos(e), s = Math.sin(e), n = this.x - t.x, r = this.y - t.y;
    return this.x = n * i - r * s + t.x, this.y = n * s + r * i + t.y, this;
  }
  /**
   * Sets each component of this vector to a pseudo-random value between `0` and
   * `1`, excluding `1`.
   *
   * @return {Vector2} A reference to this vector.
   */
  random() {
    return this.x = Math.random(), this.y = Math.random(), this;
  }
  *[Symbol.iterator]() {
    yield this.x, yield this.y;
  }
}
class Ie {
  /**
   * Constructs a new quaternion.
   *
   * @param {number} [x=0] - The x value of this quaternion.
   * @param {number} [y=0] - The y value of this quaternion.
   * @param {number} [z=0] - The z value of this quaternion.
   * @param {number} [w=1] - The w value of this quaternion.
   */
  constructor(t = 0, e = 0, i = 0, s = 1) {
    this.isQuaternion = !0, this._x = t, this._y = e, this._z = i, this._w = s;
  }
  /**
   * Interpolates between two quaternions via SLERP. This implementation assumes the
   * quaternion data are managed in flat arrays.
   *
   * @param {Array<number>} dst - The destination array.
   * @param {number} dstOffset - An offset into the destination array.
   * @param {Array<number>} src0 - The source array of the first quaternion.
   * @param {number} srcOffset0 - An offset into the first source array.
   * @param {Array<number>} src1 -  The source array of the second quaternion.
   * @param {number} srcOffset1 - An offset into the second source array.
   * @param {number} t - The interpolation factor. A value in the range `[0,1]` will interpolate. A value outside the range `[0,1]` will extrapolate.
   * @see {@link Quaternion#slerp}
   */
  static slerpFlat(t, e, i, s, n, r, a) {
    let o = i[s + 0], c = i[s + 1], h = i[s + 2], l = i[s + 3], u = n[r + 0], d = n[r + 1], y = n[r + 2], m = n[r + 3];
    if (l !== m || o !== u || c !== d || h !== y) {
      let z = o * u + c * d + h * y + l * m;
      z < 0 && (u = -u, d = -d, y = -y, m = -m, z = -z);
      let b = 1 - a;
      if (z < 0.9995) {
        const p = Math.acos(z), w = Math.sin(p);
        b = Math.sin(b * p) / w, a = Math.sin(a * p) / w, o = o * b + u * a, c = c * b + d * a, h = h * b + y * a, l = l * b + m * a;
      } else {
        o = o * b + u * a, c = c * b + d * a, h = h * b + y * a, l = l * b + m * a;
        const p = 1 / Math.sqrt(o * o + c * c + h * h + l * l);
        o *= p, c *= p, h *= p, l *= p;
      }
    }
    t[e] = o, t[e + 1] = c, t[e + 2] = h, t[e + 3] = l;
  }
  /**
   * Multiplies two quaternions. This implementation assumes the quaternion data are managed
   * in flat arrays.
   *
   * @param {Array<number>} dst - The destination array.
   * @param {number} dstOffset - An offset into the destination array.
   * @param {Array<number>} src0 - The source array of the first quaternion.
   * @param {number} srcOffset0 - An offset into the first source array.
   * @param {Array<number>} src1 -  The source array of the second quaternion.
   * @param {number} srcOffset1 - An offset into the second source array.
   * @return {Array<number>} The destination array.
   * @see {@link Quaternion#multiplyQuaternions}.
   */
  static multiplyQuaternionsFlat(t, e, i, s, n, r) {
    const a = i[s], o = i[s + 1], c = i[s + 2], h = i[s + 3], l = n[r], u = n[r + 1], d = n[r + 2], y = n[r + 3];
    return t[e] = a * y + h * l + o * d - c * u, t[e + 1] = o * y + h * u + c * l - a * d, t[e + 2] = c * y + h * d + a * u - o * l, t[e + 3] = h * y - a * l - o * u - c * d, t;
  }
  /**
   * The x value of this quaternion.
   *
   * @type {number}
   * @default 0
   */
  get x() {
    return this._x;
  }
  set x(t) {
    this._x = t, this._onChangeCallback();
  }
  /**
   * The y value of this quaternion.
   *
   * @type {number}
   * @default 0
   */
  get y() {
    return this._y;
  }
  set y(t) {
    this._y = t, this._onChangeCallback();
  }
  /**
   * The z value of this quaternion.
   *
   * @type {number}
   * @default 0
   */
  get z() {
    return this._z;
  }
  set z(t) {
    this._z = t, this._onChangeCallback();
  }
  /**
   * The w value of this quaternion.
   *
   * @type {number}
   * @default 1
   */
  get w() {
    return this._w;
  }
  set w(t) {
    this._w = t, this._onChangeCallback();
  }
  /**
   * Sets the quaternion components.
   *
   * @param {number} x - The x value of this quaternion.
   * @param {number} y - The y value of this quaternion.
   * @param {number} z - The z value of this quaternion.
   * @param {number} w - The w value of this quaternion.
   * @return {Quaternion} A reference to this quaternion.
   */
  set(t, e, i, s) {
    return this._x = t, this._y = e, this._z = i, this._w = s, this._onChangeCallback(), this;
  }
  /**
   * Returns a new quaternion with copied values from this instance.
   *
   * @return {Quaternion} A clone of this instance.
   */
  clone() {
    return new this.constructor(this._x, this._y, this._z, this._w);
  }
  /**
   * Copies the values of the given quaternion to this instance.
   *
   * @param {Quaternion} quaternion - The quaternion to copy.
   * @return {Quaternion} A reference to this quaternion.
   */
  copy(t) {
    return this._x = t.x, this._y = t.y, this._z = t.z, this._w = t.w, this._onChangeCallback(), this;
  }
  /**
   * Sets this quaternion from the rotation specified by the given
   * Euler angles.
   *
   * @param {Euler} euler - The Euler angles.
   * @param {boolean} [update=true] - Whether the internal `onChange` callback should be executed or not.
   * @return {Quaternion} A reference to this quaternion.
   */
  setFromEuler(t, e = !0) {
    const i = t._x, s = t._y, n = t._z, r = t._order, a = Math.cos, o = Math.sin, c = a(i / 2), h = a(s / 2), l = a(n / 2), u = o(i / 2), d = o(s / 2), y = o(n / 2);
    switch (r) {
      case "XYZ":
        this._x = u * h * l + c * d * y, this._y = c * d * l - u * h * y, this._z = c * h * y + u * d * l, this._w = c * h * l - u * d * y;
        break;
      case "YXZ":
        this._x = u * h * l + c * d * y, this._y = c * d * l - u * h * y, this._z = c * h * y - u * d * l, this._w = c * h * l + u * d * y;
        break;
      case "ZXY":
        this._x = u * h * l - c * d * y, this._y = c * d * l + u * h * y, this._z = c * h * y + u * d * l, this._w = c * h * l - u * d * y;
        break;
      case "ZYX":
        this._x = u * h * l - c * d * y, this._y = c * d * l + u * h * y, this._z = c * h * y - u * d * l, this._w = c * h * l + u * d * y;
        break;
      case "YZX":
        this._x = u * h * l + c * d * y, this._y = c * d * l + u * h * y, this._z = c * h * y - u * d * l, this._w = c * h * l - u * d * y;
        break;
      case "XZY":
        this._x = u * h * l - c * d * y, this._y = c * d * l - u * h * y, this._z = c * h * y + u * d * l, this._w = c * h * l + u * d * y;
        break;
      default:
        pt("Quaternion: .setFromEuler() encountered an unknown order: " + r);
    }
    return e === !0 && this._onChangeCallback(), this;
  }
  /**
   * Sets this quaternion from the given axis and angle.
   *
   * @param {Vector3} axis - The normalized axis.
   * @param {number} angle - The angle in radians.
   * @return {Quaternion} A reference to this quaternion.
   */
  setFromAxisAngle(t, e) {
    const i = e / 2, s = Math.sin(i);
    return this._x = t.x * s, this._y = t.y * s, this._z = t.z * s, this._w = Math.cos(i), this._onChangeCallback(), this;
  }
  /**
   * Sets this quaternion from the given rotation matrix.
   *
   * @param {Matrix4} m - A 4x4 matrix of which the upper 3x3 of matrix is a pure rotation matrix (i.e. unscaled).
   * @return {Quaternion} A reference to this quaternion.
   */
  setFromRotationMatrix(t) {
    const e = t.elements, i = e[0], s = e[4], n = e[8], r = e[1], a = e[5], o = e[9], c = e[2], h = e[6], l = e[10], u = i + a + l;
    if (u > 0) {
      const d = 0.5 / Math.sqrt(u + 1);
      this._w = 0.25 / d, this._x = (h - o) * d, this._y = (n - c) * d, this._z = (r - s) * d;
    } else if (i > a && i > l) {
      const d = 2 * Math.sqrt(1 + i - a - l);
      this._w = (h - o) / d, this._x = 0.25 * d, this._y = (s + r) / d, this._z = (n + c) / d;
    } else if (a > l) {
      const d = 2 * Math.sqrt(1 + a - i - l);
      this._w = (n - c) / d, this._x = (s + r) / d, this._y = 0.25 * d, this._z = (o + h) / d;
    } else {
      const d = 2 * Math.sqrt(1 + l - i - a);
      this._w = (r - s) / d, this._x = (n + c) / d, this._y = (o + h) / d, this._z = 0.25 * d;
    }
    return this._onChangeCallback(), this;
  }
  /**
   * Sets this quaternion to the rotation required to rotate the direction vector
   * `vFrom` to the direction vector `vTo`.
   *
   * @param {Vector3} vFrom - The first (normalized) direction vector.
   * @param {Vector3} vTo - The second (normalized) direction vector.
   * @return {Quaternion} A reference to this quaternion.
   */
  setFromUnitVectors(t, e) {
    let i = t.dot(e) + 1;
    return i < 1e-8 ? (i = 0, Math.abs(t.x) > Math.abs(t.z) ? (this._x = -t.y, this._y = t.x, this._z = 0, this._w = i) : (this._x = 0, this._y = -t.z, this._z = t.y, this._w = i)) : (this._x = t.y * e.z - t.z * e.y, this._y = t.z * e.x - t.x * e.z, this._z = t.x * e.y - t.y * e.x, this._w = i), this.normalize();
  }
  /**
   * Returns the angle between this quaternion and the given one in radians.
   *
   * @param {Quaternion} q - The quaternion to compute the angle with.
   * @return {number} The angle in radians.
   */
  angleTo(t) {
    return 2 * Math.acos(Math.abs(k(this.dot(t), -1, 1)));
  }
  /**
   * Rotates this quaternion by a given angular step to the given quaternion.
   * The method ensures that the final quaternion will not overshoot `q`.
   *
   * @param {Quaternion} q - The target quaternion.
   * @param {number} step - The angular step in radians.
   * @return {Quaternion} A reference to this quaternion.
   */
  rotateTowards(t, e) {
    const i = this.angleTo(t);
    if (i === 0) return this;
    const s = Math.min(1, e / i);
    return this.slerp(t, s), this;
  }
  /**
   * Sets this quaternion to the identity quaternion; that is, to the
   * quaternion that represents "no rotation".
   *
   * @return {Quaternion} A reference to this quaternion.
   */
  identity() {
    return this.set(0, 0, 0, 1);
  }
  /**
   * Inverts this quaternion via {@link Quaternion#conjugate}. The
   * quaternion is assumed to have unit length.
   *
   * @return {Quaternion} A reference to this quaternion.
   */
  invert() {
    return this.conjugate();
  }
  /**
   * Returns the rotational conjugate of this quaternion. The conjugate of a
   * quaternion represents the same rotation in the opposite direction about
   * the rotational axis.
   *
   * @return {Quaternion} A reference to this quaternion.
   */
  conjugate() {
    return this._x *= -1, this._y *= -1, this._z *= -1, this._onChangeCallback(), this;
  }
  /**
   * Calculates the dot product of this quaternion and the given one.
   *
   * @param {Quaternion} v - The quaternion to compute the dot product with.
   * @return {number} The result of the dot product.
   */
  dot(t) {
    return this._x * t._x + this._y * t._y + this._z * t._z + this._w * t._w;
  }
  /**
   * Computes the squared Euclidean length (straight-line length) of this quaternion,
   * considered as a 4 dimensional vector. This can be useful if you are comparing the
   * lengths of two quaternions, as this is a slightly more efficient calculation than
   * {@link Quaternion#length}.
   *
   * @return {number} The squared Euclidean length.
   */
  lengthSq() {
    return this._x * this._x + this._y * this._y + this._z * this._z + this._w * this._w;
  }
  /**
   * Computes the Euclidean length (straight-line length) of this quaternion,
   * considered as a 4 dimensional vector.
   *
   * @return {number} The Euclidean length.
   */
  length() {
    return Math.sqrt(this._x * this._x + this._y * this._y + this._z * this._z + this._w * this._w);
  }
  /**
   * Normalizes this quaternion - that is, calculated the quaternion that performs
   * the same rotation as this one, but has a length equal to `1`.
   *
   * @return {Quaternion} A reference to this quaternion.
   */
  normalize() {
    let t = this.length();
    return t === 0 ? (this._x = 0, this._y = 0, this._z = 0, this._w = 1) : (t = 1 / t, this._x = this._x * t, this._y = this._y * t, this._z = this._z * t, this._w = this._w * t), this._onChangeCallback(), this;
  }
  /**
   * Multiplies this quaternion by the given one.
   *
   * @param {Quaternion} q - The quaternion.
   * @return {Quaternion} A reference to this quaternion.
   */
  multiply(t) {
    return this.multiplyQuaternions(this, t);
  }
  /**
   * Pre-multiplies this quaternion by the given one.
   *
   * @param {Quaternion} q - The quaternion.
   * @return {Quaternion} A reference to this quaternion.
   */
  premultiply(t) {
    return this.multiplyQuaternions(t, this);
  }
  /**
   * Multiplies the given quaternions and stores the result in this instance.
   *
   * @param {Quaternion} a - The first quaternion.
   * @param {Quaternion} b - The second quaternion.
   * @return {Quaternion} A reference to this quaternion.
   */
  multiplyQuaternions(t, e) {
    const i = t._x, s = t._y, n = t._z, r = t._w, a = e._x, o = e._y, c = e._z, h = e._w;
    return this._x = i * h + r * a + s * c - n * o, this._y = s * h + r * o + n * a - i * c, this._z = n * h + r * c + i * o - s * a, this._w = r * h - i * a - s * o - n * c, this._onChangeCallback(), this;
  }
  /**
   * Performs a spherical linear interpolation between this quaternion and the target quaternion.
   *
   * @param {Quaternion} qb - The target quaternion.
   * @param {number} t - The interpolation factor. A value in the range `[0,1]` will interpolate. A value outside the range `[0,1]` will extrapolate.
   * @return {Quaternion} A reference to this quaternion.
   */
  slerp(t, e) {
    let i = t._x, s = t._y, n = t._z, r = t._w, a = this.dot(t);
    a < 0 && (i = -i, s = -s, n = -n, r = -r, a = -a);
    let o = 1 - e;
    if (a < 0.9995) {
      const c = Math.acos(a), h = Math.sin(c);
      o = Math.sin(o * c) / h, e = Math.sin(e * c) / h, this._x = this._x * o + i * e, this._y = this._y * o + s * e, this._z = this._z * o + n * e, this._w = this._w * o + r * e, this._onChangeCallback();
    } else
      this._x = this._x * o + i * e, this._y = this._y * o + s * e, this._z = this._z * o + n * e, this._w = this._w * o + r * e, this.normalize();
    return this;
  }
  /**
   * Performs a spherical linear interpolation between the given quaternions
   * and stores the result in this quaternion.
   *
   * @param {Quaternion} qa - The source quaternion.
   * @param {Quaternion} qb - The target quaternion.
   * @param {number} t - The interpolation factor in the closed interval `[0, 1]`.
   * @return {Quaternion} A reference to this quaternion.
   */
  slerpQuaternions(t, e, i) {
    return this.copy(t).slerp(e, i);
  }
  /**
   * Sets this quaternion to a uniformly random, normalized quaternion.
   *
   * @return {Quaternion} A reference to this quaternion.
   */
  random() {
    const t = 2 * Math.PI * Math.random(), e = 2 * Math.PI * Math.random(), i = Math.random(), s = Math.sqrt(1 - i), n = Math.sqrt(i);
    return this.set(
      s * Math.sin(t),
      s * Math.cos(t),
      n * Math.sin(e),
      n * Math.cos(e)
    );
  }
  /**
   * Returns `true` if this quaternion is equal with the given one.
   *
   * @param {Quaternion} quaternion - The quaternion to test for equality.
   * @return {boolean} Whether this quaternion is equal with the given one.
   */
  equals(t) {
    return t._x === this._x && t._y === this._y && t._z === this._z && t._w === this._w;
  }
  /**
   * Sets this quaternion's components from the given array.
   *
   * @param {Array<number>} array - An array holding the quaternion component values.
   * @param {number} [offset=0] - The offset into the array.
   * @return {Quaternion} A reference to this quaternion.
   */
  fromArray(t, e = 0) {
    return this._x = t[e], this._y = t[e + 1], this._z = t[e + 2], this._w = t[e + 3], this._onChangeCallback(), this;
  }
  /**
   * Writes the components of this quaternion to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number>} [array=[]] - The target array holding the quaternion components.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number>} The quaternion components.
   */
  toArray(t = [], e = 0) {
    return t[e] = this._x, t[e + 1] = this._y, t[e + 2] = this._z, t[e + 3] = this._w, t;
  }
  /**
   * Sets the components of this quaternion from the given buffer attribute.
   *
   * @param {BufferAttribute} attribute - The buffer attribute holding quaternion data.
   * @param {number} index - The index into the attribute.
   * @return {Quaternion} A reference to this quaternion.
   */
  fromBufferAttribute(t, e) {
    return this._x = t.getX(e), this._y = t.getY(e), this._z = t.getZ(e), this._w = t.getW(e), this._onChangeCallback(), this;
  }
  /**
   * This methods defines the serialization result of this class. Returns the
   * numerical elements of this quaternion in an array of format `[x, y, z, w]`.
   *
   * @return {Array<number>} The serialized quaternion.
   */
  toJSON() {
    return this.toArray();
  }
  _onChange(t) {
    return this._onChangeCallback = t, this;
  }
  _onChangeCallback() {
  }
  *[Symbol.iterator]() {
    yield this._x, yield this._y, yield this._z, yield this._w;
  }
}
class S {
  static {
    S.prototype.isVector3 = !0;
  }
  /**
   * Constructs a new 3D vector.
   *
   * @param {number} [x=0] - The x value of this vector.
   * @param {number} [y=0] - The y value of this vector.
   * @param {number} [z=0] - The z value of this vector.
   */
  constructor(t = 0, e = 0, i = 0) {
    this.x = t, this.y = e, this.z = i;
  }
  /**
   * Sets the vector components.
   *
   * @param {number} x - The value of the x component.
   * @param {number} y - The value of the y component.
   * @param {number} z - The value of the z component.
   * @return {Vector3} A reference to this vector.
   */
  set(t, e, i) {
    return i === void 0 && (i = this.z), this.x = t, this.y = e, this.z = i, this;
  }
  /**
   * Sets the vector components to the same value.
   *
   * @param {number} scalar - The value to set for all vector components.
   * @return {Vector3} A reference to this vector.
   */
  setScalar(t) {
    return this.x = t, this.y = t, this.z = t, this;
  }
  /**
   * Sets the vector's x component to the given value.
   *
   * @param {number} x - The value to set.
   * @return {Vector3} A reference to this vector.
   */
  setX(t) {
    return this.x = t, this;
  }
  /**
   * Sets the vector's y component to the given value.
   *
   * @param {number} y - The value to set.
   * @return {Vector3} A reference to this vector.
   */
  setY(t) {
    return this.y = t, this;
  }
  /**
   * Sets the vector's z component to the given value.
   *
   * @param {number} z - The value to set.
   * @return {Vector3} A reference to this vector.
   */
  setZ(t) {
    return this.z = t, this;
  }
  /**
   * Allows to set a vector component with an index.
   *
   * @param {number} index - The component index. `0` equals to x, `1` equals to y, `2` equals to z.
   * @param {number} value - The value to set.
   * @return {Vector3} A reference to this vector.
   */
  setComponent(t, e) {
    switch (t) {
      case 0:
        this.x = e;
        break;
      case 1:
        this.y = e;
        break;
      case 2:
        this.z = e;
        break;
      default:
        throw new Error("THREE.Vector3: index is out of range: " + t);
    }
    return this;
  }
  /**
   * Returns the value of the vector component which matches the given index.
   *
   * @param {number} index - The component index. `0` equals to x, `1` equals to y, `2` equals to z.
   * @return {number} A vector component value.
   */
  getComponent(t) {
    switch (t) {
      case 0:
        return this.x;
      case 1:
        return this.y;
      case 2:
        return this.z;
      default:
        throw new Error("THREE.Vector3: index is out of range: " + t);
    }
  }
  /**
   * Returns a new vector with copied values from this instance.
   *
   * @return {Vector3} A clone of this instance.
   */
  clone() {
    return new this.constructor(this.x, this.y, this.z);
  }
  /**
   * Copies the values of the given vector to this instance.
   *
   * @param {Vector3} v - The vector to copy.
   * @return {Vector3} A reference to this vector.
   */
  copy(t) {
    return this.x = t.x, this.y = t.y, this.z = t.z, this;
  }
  /**
   * Adds the given vector to this instance.
   *
   * @param {Vector3} v - The vector to add.
   * @return {Vector3} A reference to this vector.
   */
  add(t) {
    return this.x += t.x, this.y += t.y, this.z += t.z, this;
  }
  /**
   * Adds the given scalar value to all components of this instance.
   *
   * @param {number} s - The scalar to add.
   * @return {Vector3} A reference to this vector.
   */
  addScalar(t) {
    return this.x += t, this.y += t, this.z += t, this;
  }
  /**
   * Adds the given vectors and stores the result in this instance.
   *
   * @param {Vector3} a - The first vector.
   * @param {Vector3} b - The second vector.
   * @return {Vector3} A reference to this vector.
   */
  addVectors(t, e) {
    return this.x = t.x + e.x, this.y = t.y + e.y, this.z = t.z + e.z, this;
  }
  /**
   * Adds the given vector scaled by the given factor to this instance.
   *
   * @param {Vector3|Vector4} v - The vector.
   * @param {number} s - The factor that scales `v`.
   * @return {Vector3} A reference to this vector.
   */
  addScaledVector(t, e) {
    return this.x += t.x * e, this.y += t.y * e, this.z += t.z * e, this;
  }
  /**
   * Subtracts the given vector from this instance.
   *
   * @param {Vector3} v - The vector to subtract.
   * @return {Vector3} A reference to this vector.
   */
  sub(t) {
    return this.x -= t.x, this.y -= t.y, this.z -= t.z, this;
  }
  /**
   * Subtracts the given scalar value from all components of this instance.
   *
   * @param {number} s - The scalar to subtract.
   * @return {Vector3} A reference to this vector.
   */
  subScalar(t) {
    return this.x -= t, this.y -= t, this.z -= t, this;
  }
  /**
   * Subtracts the given vectors and stores the result in this instance.
   *
   * @param {Vector3} a - The first vector.
   * @param {Vector3} b - The second vector.
   * @return {Vector3} A reference to this vector.
   */
  subVectors(t, e) {
    return this.x = t.x - e.x, this.y = t.y - e.y, this.z = t.z - e.z, this;
  }
  /**
   * Multiplies the given vector with this instance.
   *
   * @param {Vector3} v - The vector to multiply.
   * @return {Vector3} A reference to this vector.
   */
  multiply(t) {
    return this.x *= t.x, this.y *= t.y, this.z *= t.z, this;
  }
  /**
   * Multiplies the given scalar value with all components of this instance.
   *
   * @param {number} scalar - The scalar to multiply.
   * @return {Vector3} A reference to this vector.
   */
  multiplyScalar(t) {
    return this.x *= t, this.y *= t, this.z *= t, this;
  }
  /**
   * Multiplies the given vectors and stores the result in this instance.
   *
   * @param {Vector3} a - The first vector.
   * @param {Vector3} b - The second vector.
   * @return {Vector3} A reference to this vector.
   */
  multiplyVectors(t, e) {
    return this.x = t.x * e.x, this.y = t.y * e.y, this.z = t.z * e.z, this;
  }
  /**
   * Applies the given Euler rotation to this vector.
   *
   * @param {Euler} euler - The Euler angles.
   * @return {Vector3} A reference to this vector.
   */
  applyEuler(t) {
    return this.applyQuaternion(us.setFromEuler(t));
  }
  /**
   * Applies a rotation specified by an axis and an angle to this vector.
   *
   * @param {Vector3} axis - A normalized vector representing the rotation axis.
   * @param {number} angle - The angle in radians.
   * @return {Vector3} A reference to this vector.
   */
  applyAxisAngle(t, e) {
    return this.applyQuaternion(us.setFromAxisAngle(t, e));
  }
  /**
   * Multiplies this vector with the given 3x3 matrix.
   *
   * @param {Matrix3} m - The 3x3 matrix.
   * @return {Vector3} A reference to this vector.
   */
  applyMatrix3(t) {
    const e = this.x, i = this.y, s = this.z, n = t.elements;
    return this.x = n[0] * e + n[3] * i + n[6] * s, this.y = n[1] * e + n[4] * i + n[7] * s, this.z = n[2] * e + n[5] * i + n[8] * s, this;
  }
  /**
   * Multiplies this vector by the given normal matrix and normalizes
   * the result.
   *
   * @param {Matrix3} m - The normal matrix.
   * @return {Vector3} A reference to this vector.
   */
  applyNormalMatrix(t) {
    return this.applyMatrix3(t).normalize();
  }
  /**
   * Multiplies this vector (with an implicit 1 in the 4th dimension) by m, and
   * divides by perspective.
   *
   * @param {Matrix4} m - The matrix to apply.
   * @return {Vector3} A reference to this vector.
   */
  applyMatrix4(t) {
    const e = this.x, i = this.y, s = this.z, n = t.elements, r = 1 / (n[3] * e + n[7] * i + n[11] * s + n[15]);
    return this.x = (n[0] * e + n[4] * i + n[8] * s + n[12]) * r, this.y = (n[1] * e + n[5] * i + n[9] * s + n[13]) * r, this.z = (n[2] * e + n[6] * i + n[10] * s + n[14]) * r, this;
  }
  /**
   * Applies the given Quaternion to this vector.
   *
   * @param {Quaternion} q - The Quaternion.
   * @return {Vector3} A reference to this vector.
   */
  applyQuaternion(t) {
    const e = this.x, i = this.y, s = this.z, n = t.x, r = t.y, a = t.z, o = t.w, c = 2 * (r * s - a * i), h = 2 * (a * e - n * s), l = 2 * (n * i - r * e);
    return this.x = e + o * c + r * l - a * h, this.y = i + o * h + a * c - n * l, this.z = s + o * l + n * h - r * c, this;
  }
  /**
   * Projects this vector from world space into the camera's normalized
   * device coordinate (NDC) space.
   *
   * @param {Camera} camera - The camera.
   * @return {Vector3} A reference to this vector.
   */
  project(t) {
    return this.applyMatrix4(t.matrixWorldInverse).applyMatrix4(t.projectionMatrix);
  }
  /**
   * Unprojects this vector from the camera's normalized device coordinate (NDC)
   * space into world space.
   *
   * @param {Camera} camera - The camera.
   * @return {Vector3} A reference to this vector.
   */
  unproject(t) {
    return this.applyMatrix4(t.projectionMatrixInverse).applyMatrix4(t.matrixWorld);
  }
  /**
   * Transforms this vector by the upper left 3x3 sub-matrix of the given 4x4 matrix,
   * and normalizes the result.
   *
   * @param {Matrix4} m - The matrix.
   * @return {Vector3} A reference to this vector.
   */
  transformDirection(t) {
    const e = this.x, i = this.y, s = this.z, n = t.elements;
    return this.x = n[0] * e + n[4] * i + n[8] * s, this.y = n[1] * e + n[5] * i + n[9] * s, this.z = n[2] * e + n[6] * i + n[10] * s, this.normalize();
  }
  /**
   * Divides this instance by the given vector.
   *
   * @param {Vector3} v - The vector to divide.
   * @return {Vector3} A reference to this vector.
   */
  divide(t) {
    return this.x /= t.x, this.y /= t.y, this.z /= t.z, this;
  }
  /**
   * Divides this vector by the given scalar.
   *
   * @param {number} scalar - The scalar to divide.
   * @return {Vector3} A reference to this vector.
   */
  divideScalar(t) {
    return this.multiplyScalar(1 / t);
  }
  /**
   * If this vector's x, y or z value is greater than the given vector's x, y or z
   * value, replace that value with the corresponding min value.
   *
   * @param {Vector3} v - The vector.
   * @return {Vector3} A reference to this vector.
   */
  min(t) {
    return this.x = Math.min(this.x, t.x), this.y = Math.min(this.y, t.y), this.z = Math.min(this.z, t.z), this;
  }
  /**
   * If this vector's x, y or z value is less than the given vector's x, y or z
   * value, replace that value with the corresponding max value.
   *
   * @param {Vector3} v - The vector.
   * @return {Vector3} A reference to this vector.
   */
  max(t) {
    return this.x = Math.max(this.x, t.x), this.y = Math.max(this.y, t.y), this.z = Math.max(this.z, t.z), this;
  }
  /**
   * If this vector's x, y or z value is greater than the max vector's x, y or z
   * value, it is replaced by the corresponding value.
   * If this vector's x, y or z value is less than the min vector's x, y or z value,
   * it is replaced by the corresponding value.
   *
   * @param {Vector3} min - The minimum x, y and z values.
   * @param {Vector3} max - The maximum x, y and z values in the desired range.
   * @return {Vector3} A reference to this vector.
   */
  clamp(t, e) {
    return this.x = k(this.x, t.x, e.x), this.y = k(this.y, t.y, e.y), this.z = k(this.z, t.z, e.z), this;
  }
  /**
   * If this vector's x, y or z values are greater than the max value, they are
   * replaced by the max value.
   * If this vector's x, y or z values are less than the min value, they are
   * replaced by the min value.
   *
   * @param {number} minVal - The minimum value the components will be clamped to.
   * @param {number} maxVal - The maximum value the components will be clamped to.
   * @return {Vector3} A reference to this vector.
   */
  clampScalar(t, e) {
    return this.x = k(this.x, t, e), this.y = k(this.y, t, e), this.z = k(this.z, t, e), this;
  }
  /**
   * If this vector's length is greater than the max value, it is replaced by
   * the max value.
   * If this vector's length is less than the min value, it is replaced by the
   * min value.
   *
   * @param {number} min - The minimum value the vector length will be clamped to.
   * @param {number} max - The maximum value the vector length will be clamped to.
   * @return {Vector3} A reference to this vector.
   */
  clampLength(t, e) {
    const i = this.length();
    return this.divideScalar(i || 1).multiplyScalar(k(i, t, e));
  }
  /**
   * The components of this vector are rounded down to the nearest integer value.
   *
   * @return {Vector3} A reference to this vector.
   */
  floor() {
    return this.x = Math.floor(this.x), this.y = Math.floor(this.y), this.z = Math.floor(this.z), this;
  }
  /**
   * The components of this vector are rounded up to the nearest integer value.
   *
   * @return {Vector3} A reference to this vector.
   */
  ceil() {
    return this.x = Math.ceil(this.x), this.y = Math.ceil(this.y), this.z = Math.ceil(this.z), this;
  }
  /**
   * The components of this vector are rounded to the nearest integer value
   *
   * @return {Vector3} A reference to this vector.
   */
  round() {
    return this.x = Math.round(this.x), this.y = Math.round(this.y), this.z = Math.round(this.z), this;
  }
  /**
   * The components of this vector are rounded towards zero (up if negative,
   * down if positive) to an integer value.
   *
   * @return {Vector3} A reference to this vector.
   */
  roundToZero() {
    return this.x = Math.trunc(this.x), this.y = Math.trunc(this.y), this.z = Math.trunc(this.z), this;
  }
  /**
   * Inverts this vector - i.e. sets x = -x, y = -y and z = -z.
   *
   * @return {Vector3} A reference to this vector.
   */
  negate() {
    return this.x = -this.x, this.y = -this.y, this.z = -this.z, this;
  }
  /**
   * Calculates the dot product of the given vector with this instance.
   *
   * @param {Vector3} v - The vector to compute the dot product with.
   * @return {number} The result of the dot product.
   */
  dot(t) {
    return this.x * t.x + this.y * t.y + this.z * t.z;
  }
  /**
   * Computes the square of the Euclidean length (straight-line length) from
   * (0, 0, 0) to (x, y, z). If you are comparing the lengths of vectors, you should
   * compare the length squared instead as it is slightly more efficient to calculate.
   *
   * @return {number} The square length of this vector.
   */
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  /**
   * Computes the  Euclidean length (straight-line length) from (0, 0, 0) to (x, y, z).
   *
   * @return {number} The length of this vector.
   */
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  /**
   * Computes the Manhattan length of this vector.
   *
   * @return {number} The length of this vector.
   */
  manhattanLength() {
    return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z);
  }
  /**
   * Converts this vector to a unit vector - that is, sets it equal to a vector
   * with the same direction as this one, but with a vector length of `1`.
   *
   * @return {Vector3} A reference to this vector.
   */
  normalize() {
    return this.divideScalar(this.length() || 1);
  }
  /**
   * Sets this vector to a vector with the same direction as this one, but
   * with the specified length.
   *
   * @param {number} length - The new length of this vector.
   * @return {Vector3} A reference to this vector.
   */
  setLength(t) {
    return this.normalize().multiplyScalar(t);
  }
  /**
   * Linearly interpolates between the given vector and this instance, where
   * alpha is the percent distance along the line - alpha = 0 will be this
   * vector, and alpha = 1 will be the given one.
   *
   * @param {Vector3} v - The vector to interpolate towards.
   * @param {number} alpha - The interpolation factor, typically in the closed interval `[0, 1]`.
   * @return {Vector3} A reference to this vector.
   */
  lerp(t, e) {
    return this.x += (t.x - this.x) * e, this.y += (t.y - this.y) * e, this.z += (t.z - this.z) * e, this;
  }
  /**
   * Linearly interpolates between the given vectors, where alpha is the percent
   * distance along the line - alpha = 0 will be first vector, and alpha = 1 will
   * be the second one. The result is stored in this instance.
   *
   * @param {Vector3} v1 - The first vector.
   * @param {Vector3} v2 - The second vector.
   * @param {number} alpha - The interpolation factor, typically in the closed interval `[0, 1]`.
   * @return {Vector3} A reference to this vector.
   */
  lerpVectors(t, e, i) {
    return this.x = t.x + (e.x - t.x) * i, this.y = t.y + (e.y - t.y) * i, this.z = t.z + (e.z - t.z) * i, this;
  }
  /**
   * Calculates the cross product of the given vector with this instance.
   *
   * @param {Vector3} v - The vector to compute the cross product with.
   * @return {Vector3} The result of the cross product.
   */
  cross(t) {
    return this.crossVectors(this, t);
  }
  /**
   * Calculates the cross product of the given vectors and stores the result
   * in this instance.
   *
   * @param {Vector3} a - The first vector.
   * @param {Vector3} b - The second vector.
   * @return {Vector3} A reference to this vector.
   */
  crossVectors(t, e) {
    const i = t.x, s = t.y, n = t.z, r = e.x, a = e.y, o = e.z;
    return this.x = s * o - n * a, this.y = n * r - i * o, this.z = i * a - s * r, this;
  }
  /**
   * Projects this vector onto the given one.
   *
   * @param {Vector3} v - The vector to project to.
   * @return {Vector3} A reference to this vector.
   */
  projectOnVector(t) {
    const e = t.lengthSq();
    if (e === 0) return this.set(0, 0, 0);
    const i = t.dot(this) / e;
    return this.copy(t).multiplyScalar(i);
  }
  /**
   * Projects this vector onto a plane by subtracting this
   * vector projected onto the plane's normal from this vector.
   *
   * @param {Vector3} planeNormal - The plane normal.
   * @return {Vector3} A reference to this vector.
   */
  projectOnPlane(t) {
    return mi.copy(this).projectOnVector(t), this.sub(mi);
  }
  /**
   * Reflects this vector off a plane orthogonal to the given normal vector.
   *
   * @param {Vector3} normal - The (normalized) normal vector.
   * @return {Vector3} A reference to this vector.
   */
  reflect(t) {
    return this.sub(mi.copy(t).multiplyScalar(2 * this.dot(t)));
  }
  /**
   * Returns the angle between the given vector and this instance in radians.
   *
   * @param {Vector3} v - The vector to compute the angle with.
   * @return {number} The angle in radians.
   */
  angleTo(t) {
    const e = Math.sqrt(this.lengthSq() * t.lengthSq());
    if (e === 0) return Math.PI / 2;
    const i = this.dot(t) / e;
    return Math.acos(k(i, -1, 1));
  }
  /**
   * Computes the distance from the given vector to this instance.
   *
   * @param {Vector3} v - The vector to compute the distance to.
   * @return {number} The distance.
   */
  distanceTo(t) {
    return Math.sqrt(this.distanceToSquared(t));
  }
  /**
   * Computes the squared distance from the given vector to this instance.
   * If you are just comparing the distance with another distance, you should compare
   * the distance squared instead as it is slightly more efficient to calculate.
   *
   * @param {Vector3} v - The vector to compute the squared distance to.
   * @return {number} The squared distance.
   */
  distanceToSquared(t) {
    const e = this.x - t.x, i = this.y - t.y, s = this.z - t.z;
    return e * e + i * i + s * s;
  }
  /**
   * Computes the Manhattan distance from the given vector to this instance.
   *
   * @param {Vector3} v - The vector to compute the Manhattan distance to.
   * @return {number} The Manhattan distance.
   */
  manhattanDistanceTo(t) {
    return Math.abs(this.x - t.x) + Math.abs(this.y - t.y) + Math.abs(this.z - t.z);
  }
  /**
   * Sets the vector components from the given spherical coordinates.
   *
   * @param {Spherical} s - The spherical coordinates.
   * @return {Vector3} A reference to this vector.
   */
  setFromSpherical(t) {
    return this.setFromSphericalCoords(t.radius, t.phi, t.theta);
  }
  /**
   * Sets the vector components from the given spherical coordinates.
   *
   * @param {number} radius - The radius.
   * @param {number} phi - The phi angle in radians.
   * @param {number} theta - The theta angle in radians.
   * @return {Vector3} A reference to this vector.
   */
  setFromSphericalCoords(t, e, i) {
    const s = Math.sin(e) * t;
    return this.x = s * Math.sin(i), this.y = Math.cos(e) * t, this.z = s * Math.cos(i), this;
  }
  /**
   * Sets the vector components from the given cylindrical coordinates.
   *
   * @param {Cylindrical} c - The cylindrical coordinates.
   * @return {Vector3} A reference to this vector.
   */
  setFromCylindrical(t) {
    return this.setFromCylindricalCoords(t.radius, t.theta, t.y);
  }
  /**
   * Sets the vector components from the given cylindrical coordinates.
   *
   * @param {number} radius - The radius.
   * @param {number} theta - The theta angle in radians.
   * @param {number} y - The y value.
   * @return {Vector3} A reference to this vector.
   */
  setFromCylindricalCoords(t, e, i) {
    return this.x = t * Math.sin(e), this.y = i, this.z = t * Math.cos(e), this;
  }
  /**
   * Sets the vector components to the position elements of the
   * given transformation matrix.
   *
   * @param {Matrix4} m - The 4x4 matrix.
   * @return {Vector3} A reference to this vector.
   */
  setFromMatrixPosition(t) {
    const e = t.elements;
    return this.x = e[12], this.y = e[13], this.z = e[14], this;
  }
  /**
   * Sets the vector components to the scale elements of the
   * given transformation matrix.
   *
   * @param {Matrix4} m - The 4x4 matrix.
   * @return {Vector3} A reference to this vector.
   */
  setFromMatrixScale(t) {
    const e = this.setFromMatrixColumn(t, 0).length(), i = this.setFromMatrixColumn(t, 1).length(), s = this.setFromMatrixColumn(t, 2).length();
    return this.x = e, this.y = i, this.z = s, this;
  }
  /**
   * Sets the vector components from the specified matrix column.
   *
   * @param {Matrix4} m - The 4x4 matrix.
   * @param {number} index - The column index.
   * @return {Vector3} A reference to this vector.
   */
  setFromMatrixColumn(t, e) {
    return this.fromArray(t.elements, e * 4);
  }
  /**
   * Sets the vector components from the specified matrix column.
   *
   * @param {Matrix3} m - The 3x3 matrix.
   * @param {number} index - The column index.
   * @return {Vector3} A reference to this vector.
   */
  setFromMatrix3Column(t, e) {
    return this.fromArray(t.elements, e * 3);
  }
  /**
   * Sets the vector components from the given Euler angles.
   *
   * @param {Euler} e - The Euler angles to set.
   * @return {Vector3} A reference to this vector.
   */
  setFromEuler(t) {
    return this.x = t._x, this.y = t._y, this.z = t._z, this;
  }
  /**
   * Sets the vector components from the RGB components of the
   * given color.
   *
   * @param {Color} c - The color to set.
   * @return {Vector3} A reference to this vector.
   */
  setFromColor(t) {
    return this.x = t.r, this.y = t.g, this.z = t.b, this;
  }
  /**
   * Returns `true` if this vector is equal with the given one.
   *
   * @param {Vector3} v - The vector to test for equality.
   * @return {boolean} Whether this vector is equal with the given one.
   */
  equals(t) {
    return t.x === this.x && t.y === this.y && t.z === this.z;
  }
  /**
   * Sets this vector's x value to be `array[ offset ]`, y value to be `array[ offset + 1 ]`
   * and z value to be `array[ offset + 2 ]`.
   *
   * @param {Array<number>} array - An array holding the vector component values.
   * @param {number} [offset=0] - The offset into the array.
   * @return {Vector3} A reference to this vector.
   */
  fromArray(t, e = 0) {
    return this.x = t[e], this.y = t[e + 1], this.z = t[e + 2], this;
  }
  /**
   * Writes the components of this vector to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number>} [array=[]] - The target array holding the vector components.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number>} The vector components.
   */
  toArray(t = [], e = 0) {
    return t[e] = this.x, t[e + 1] = this.y, t[e + 2] = this.z, t;
  }
  /**
   * Sets the components of this vector from the given buffer attribute.
   *
   * @param {BufferAttribute} attribute - The buffer attribute holding vector data.
   * @param {number} index - The index into the attribute.
   * @return {Vector3} A reference to this vector.
   */
  fromBufferAttribute(t, e) {
    return this.x = t.getX(e), this.y = t.getY(e), this.z = t.getZ(e), this;
  }
  /**
   * Sets each component of this vector to a pseudo-random value between `0` and
   * `1`, excluding `1`.
   *
   * @return {Vector3} A reference to this vector.
   */
  random() {
    return this.x = Math.random(), this.y = Math.random(), this.z = Math.random(), this;
  }
  /**
   * Sets this vector to a uniformly random point on a unit sphere.
   *
   * @return {Vector3} A reference to this vector.
   */
  randomDirection() {
    const t = Math.random() * Math.PI * 2, e = Math.random() * 2 - 1, i = Math.sqrt(1 - e * e);
    return this.x = i * Math.cos(t), this.y = e, this.z = i * Math.sin(t), this;
  }
  *[Symbol.iterator]() {
    yield this.x, yield this.y, yield this.z;
  }
}
const mi = /* @__PURE__ */ new S(), us = /* @__PURE__ */ new Ie();
class Tt {
  static {
    Tt.prototype.isMatrix3 = !0;
  }
  /**
   * Constructs a new 3x3 matrix. The arguments are supposed to be
   * in row-major order. If no arguments are provided, the constructor
   * initializes the matrix as an identity matrix.
   *
   * @param {number} [n11] - 1-1 matrix element.
   * @param {number} [n12] - 1-2 matrix element.
   * @param {number} [n13] - 1-3 matrix element.
   * @param {number} [n21] - 2-1 matrix element.
   * @param {number} [n22] - 2-2 matrix element.
   * @param {number} [n23] - 2-3 matrix element.
   * @param {number} [n31] - 3-1 matrix element.
   * @param {number} [n32] - 3-2 matrix element.
   * @param {number} [n33] - 3-3 matrix element.
   */
  constructor(t, e, i, s, n, r, a, o, c) {
    this.elements = [
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1
    ], t !== void 0 && this.set(t, e, i, s, n, r, a, o, c);
  }
  /**
   * Sets the elements of the matrix.The arguments are supposed to be
   * in row-major order.
   *
   * @param {number} [n11] - 1-1 matrix element.
   * @param {number} [n12] - 1-2 matrix element.
   * @param {number} [n13] - 1-3 matrix element.
   * @param {number} [n21] - 2-1 matrix element.
   * @param {number} [n22] - 2-2 matrix element.
   * @param {number} [n23] - 2-3 matrix element.
   * @param {number} [n31] - 3-1 matrix element.
   * @param {number} [n32] - 3-2 matrix element.
   * @param {number} [n33] - 3-3 matrix element.
   * @return {Matrix3} A reference to this matrix.
   */
  set(t, e, i, s, n, r, a, o, c) {
    const h = this.elements;
    return h[0] = t, h[1] = s, h[2] = a, h[3] = e, h[4] = n, h[5] = o, h[6] = i, h[7] = r, h[8] = c, this;
  }
  /**
   * Sets this matrix to the 3x3 identity matrix.
   *
   * @return {Matrix3} A reference to this matrix.
   */
  identity() {
    return this.set(
      1,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Copies the values of the given matrix to this instance.
   *
   * @param {Matrix3} m - The matrix to copy.
   * @return {Matrix3} A reference to this matrix.
   */
  copy(t) {
    const e = this.elements, i = t.elements;
    return e[0] = i[0], e[1] = i[1], e[2] = i[2], e[3] = i[3], e[4] = i[4], e[5] = i[5], e[6] = i[6], e[7] = i[7], e[8] = i[8], this;
  }
  /**
   * Extracts the basis of this matrix into the three axis vectors provided.
   *
   * @param {Vector3} xAxis - The basis's x axis.
   * @param {Vector3} yAxis - The basis's y axis.
   * @param {Vector3} zAxis - The basis's z axis.
   * @return {Matrix3} A reference to this matrix.
   */
  extractBasis(t, e, i) {
    return t.setFromMatrix3Column(this, 0), e.setFromMatrix3Column(this, 1), i.setFromMatrix3Column(this, 2), this;
  }
  /**
   * Set this matrix to the upper 3x3 matrix of the given 4x4 matrix.
   *
   * @param {Matrix4} m - The 4x4 matrix.
   * @return {Matrix3} A reference to this matrix.
   */
  setFromMatrix4(t) {
    const e = t.elements;
    return this.set(
      e[0],
      e[4],
      e[8],
      e[1],
      e[5],
      e[9],
      e[2],
      e[6],
      e[10]
    ), this;
  }
  /**
   * Post-multiplies this matrix by the given 3x3 matrix.
   *
   * @param {Matrix3} m - The matrix to multiply with.
   * @return {Matrix3} A reference to this matrix.
   */
  multiply(t) {
    return this.multiplyMatrices(this, t);
  }
  /**
   * Pre-multiplies this matrix by the given 3x3 matrix.
   *
   * @param {Matrix3} m - The matrix to multiply with.
   * @return {Matrix3} A reference to this matrix.
   */
  premultiply(t) {
    return this.multiplyMatrices(t, this);
  }
  /**
   * Multiples the given 3x3 matrices and stores the result
   * in this matrix.
   *
   * @param {Matrix3} a - The first matrix.
   * @param {Matrix3} b - The second matrix.
   * @return {Matrix3} A reference to this matrix.
   */
  multiplyMatrices(t, e) {
    const i = t.elements, s = e.elements, n = this.elements, r = i[0], a = i[3], o = i[6], c = i[1], h = i[4], l = i[7], u = i[2], d = i[5], y = i[8], m = s[0], z = s[3], b = s[6], p = s[1], w = s[4], x = s[7], g = s[2], B = s[5], _ = s[8];
    return n[0] = r * m + a * p + o * g, n[3] = r * z + a * w + o * B, n[6] = r * b + a * x + o * _, n[1] = c * m + h * p + l * g, n[4] = c * z + h * w + l * B, n[7] = c * b + h * x + l * _, n[2] = u * m + d * p + y * g, n[5] = u * z + d * w + y * B, n[8] = u * b + d * x + y * _, this;
  }
  /**
   * Multiplies every component of the matrix by the given scalar.
   *
   * @param {number} s - The scalar.
   * @return {Matrix3} A reference to this matrix.
   */
  multiplyScalar(t) {
    const e = this.elements;
    return e[0] *= t, e[3] *= t, e[6] *= t, e[1] *= t, e[4] *= t, e[7] *= t, e[2] *= t, e[5] *= t, e[8] *= t, this;
  }
  /**
   * Computes and returns the determinant of this matrix.
   *
   * @return {number} The determinant.
   */
  determinant() {
    const t = this.elements, e = t[0], i = t[1], s = t[2], n = t[3], r = t[4], a = t[5], o = t[6], c = t[7], h = t[8];
    return e * r * h - e * a * c - i * n * h + i * a * o + s * n * c - s * r * o;
  }
  /**
   * Inverts this matrix, using the [analytic method](https://en.wikipedia.org/wiki/Invertible_matrix#Analytic_solution).
   * You can not invert with a determinant of zero. If you attempt this, the method produces
   * a zero matrix instead.
   *
   * @return {Matrix3} A reference to this matrix.
   */
  invert() {
    const t = this.elements, e = t[0], i = t[1], s = t[2], n = t[3], r = t[4], a = t[5], o = t[6], c = t[7], h = t[8], l = h * r - a * c, u = a * o - h * n, d = c * n - r * o, y = e * l + i * u + s * d;
    if (y === 0) return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0);
    const m = 1 / y;
    return t[0] = l * m, t[1] = (s * c - h * i) * m, t[2] = (a * i - s * r) * m, t[3] = u * m, t[4] = (h * e - s * o) * m, t[5] = (s * n - a * e) * m, t[6] = d * m, t[7] = (i * o - c * e) * m, t[8] = (r * e - i * n) * m, this;
  }
  /**
   * Transposes this matrix in place.
   *
   * @return {Matrix3} A reference to this matrix.
   */
  transpose() {
    let t;
    const e = this.elements;
    return t = e[1], e[1] = e[3], e[3] = t, t = e[2], e[2] = e[6], e[6] = t, t = e[5], e[5] = e[7], e[7] = t, this;
  }
  /**
   * Computes the normal matrix which is the inverse transpose of the upper
   * left 3x3 portion of the given 4x4 matrix.
   *
   * @param {Matrix4} matrix4 - The 4x4 matrix.
   * @return {Matrix3} A reference to this matrix.
   */
  getNormalMatrix(t) {
    return this.setFromMatrix4(t).invert().transpose();
  }
  /**
   * Transposes this matrix into the supplied array, and returns itself unchanged.
   *
   * @param {Array<number>} r - An array to store the transposed matrix elements.
   * @return {Matrix3} A reference to this matrix.
   */
  transposeIntoArray(t) {
    const e = this.elements;
    return t[0] = e[0], t[1] = e[3], t[2] = e[6], t[3] = e[1], t[4] = e[4], t[5] = e[7], t[6] = e[2], t[7] = e[5], t[8] = e[8], this;
  }
  /**
   * Sets the UV transform matrix from offset, repeat, rotation, and center.
   *
   * @param {number} tx - Offset x.
   * @param {number} ty - Offset y.
   * @param {number} sx - Repeat x.
   * @param {number} sy - Repeat y.
   * @param {number} rotation - Rotation, in radians. Positive values rotate counterclockwise.
   * @param {number} cx - Center x of rotation.
   * @param {number} cy - Center y of rotation
   * @return {Matrix3} A reference to this matrix.
   */
  setUvTransform(t, e, i, s, n, r, a) {
    const o = Math.cos(n), c = Math.sin(n);
    return this.set(
      i * o,
      i * c,
      -i * (o * r + c * a) + r + t,
      -s * c,
      s * o,
      -s * (-c * r + o * a) + a + e,
      0,
      0,
      1
    ), this;
  }
  /**
   * Scales this matrix with the given scalar values.
   *
   * @deprecated
   * @param {number} sx - The amount to scale in the X axis.
   * @param {number} sy - The amount to scale in the Y axis.
   * @return {Matrix3} A reference to this matrix.
   */
  scale(t, e) {
    return yi("Matrix3: .scale() is deprecated. Use .makeScale() instead."), this.premultiply(pi.makeScale(t, e)), this;
  }
  /**
   * Rotates this matrix by the given angle.
   *
   * @deprecated
   * @param {number} theta - The rotation in radians.
   * @return {Matrix3} A reference to this matrix.
   */
  rotate(t) {
    return yi("Matrix3: .rotate() is deprecated. Use .makeRotation() instead."), this.premultiply(pi.makeRotation(-t)), this;
  }
  /**
   * Translates this matrix by the given scalar values.
   *
   * @deprecated
   * @param {number} tx - The amount to translate in the X axis.
   * @param {number} ty - The amount to translate in the Y axis.
   * @return {Matrix3} A reference to this matrix.
   */
  translate(t, e) {
    return yi("Matrix3: .translate() is deprecated. Use .makeTranslation() instead."), this.premultiply(pi.makeTranslation(t, e)), this;
  }
  // for 2D Transforms
  /**
   * Sets this matrix as a 2D translation transform.
   *
   * @param {number|Vector2} x - The amount to translate in the X axis or alternatively a translation vector.
   * @param {number} y - The amount to translate in the Y axis.
   * @return {Matrix3} A reference to this matrix.
   */
  makeTranslation(t, e) {
    return t.isVector2 ? this.set(
      1,
      0,
      t.x,
      0,
      1,
      t.y,
      0,
      0,
      1
    ) : this.set(
      1,
      0,
      t,
      0,
      1,
      e,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a 2D rotational transformation.
   *
   * @param {number} theta - The rotation in radians.
   * @return {Matrix3} A reference to this matrix.
   */
  makeRotation(t) {
    const e = Math.cos(t), i = Math.sin(t);
    return this.set(
      e,
      -i,
      0,
      i,
      e,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a 2D scale transform.
   *
   * @param {number} x - The amount to scale in the X axis.
   * @param {number} y - The amount to scale in the Y axis.
   * @return {Matrix3} A reference to this matrix.
   */
  makeScale(t, e) {
    return this.set(
      t,
      0,
      0,
      0,
      e,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Returns `true` if this matrix is equal with the given one.
   *
   * @param {Matrix3} matrix - The matrix to test for equality.
   * @return {boolean} Whether this matrix is equal with the given one.
   */
  equals(t) {
    const e = this.elements, i = t.elements;
    for (let s = 0; s < 9; s++)
      if (e[s] !== i[s]) return !1;
    return !0;
  }
  /**
   * Sets the elements of the matrix from the given array.
   *
   * @param {Array<number>} array - The matrix elements in column-major order.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Matrix3} A reference to this matrix.
   */
  fromArray(t, e = 0) {
    for (let i = 0; i < 9; i++)
      this.elements[i] = t[i + e];
    return this;
  }
  /**
   * Writes the elements of this matrix to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number>} [array=[]] - The target array holding the matrix elements in column-major order.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number>} The matrix elements in column-major order.
   */
  toArray(t = [], e = 0) {
    const i = this.elements;
    return t[e] = i[0], t[e + 1] = i[1], t[e + 2] = i[2], t[e + 3] = i[3], t[e + 4] = i[4], t[e + 5] = i[5], t[e + 6] = i[6], t[e + 7] = i[7], t[e + 8] = i[8], t;
  }
  /**
   * Returns a matrix with copied values from this instance.
   *
   * @return {Matrix3} A clone of this instance.
   */
  clone() {
    return new this.constructor().fromArray(this.elements);
  }
}
const pi = /* @__PURE__ */ new Tt();
function xi(f) {
  return f < 0.04045 ? f * 0.0773993808 : Math.pow(f * 0.9478672986 + 0.0521327014, 2.4);
}
let $t;
class $s {
  /**
   * Returns a data URI containing a representation of the given image.
   *
   * @param {(HTMLImageElement|HTMLCanvasElement)} image - The image object.
   * @param {string} [type='image/png'] - Indicates the image format.
   * @return {string} The data URI.
   */
  static getDataURL(t, e = "image/png") {
    if (/^data:/i.test(t.src) || typeof HTMLCanvasElement > "u")
      return t.src;
    let i;
    if (t instanceof HTMLCanvasElement)
      i = t;
    else {
      $t === void 0 && ($t = hs("canvas")), $t.width = t.width, $t.height = t.height;
      const s = $t.getContext("2d");
      t instanceof ImageData ? s.putImageData(t, 0, 0) : s.drawImage(t, 0, 0, t.width, t.height), i = $t;
    }
    return i.toDataURL(e);
  }
  /**
   * Converts the given sRGB image data to linear color space.
   *
   * @param {(HTMLImageElement|HTMLCanvasElement|ImageBitmap|Object)} image - The image object.
   * @return {HTMLCanvasElement|Object} The converted image.
   */
  static sRGBToLinear(t) {
    if (typeof HTMLImageElement < "u" && t instanceof HTMLImageElement || typeof HTMLCanvasElement < "u" && t instanceof HTMLCanvasElement || typeof ImageBitmap < "u" && t instanceof ImageBitmap) {
      const e = hs("canvas");
      e.width = t.width, e.height = t.height;
      const i = e.getContext("2d");
      i.drawImage(t, 0, 0, t.width, t.height);
      const s = i.getImageData(0, 0, t.width, t.height), n = s.data;
      for (let r = 0; r < n.length; r++)
        n[r] = xi(n[r] / 255) * 255;
      return i.putImageData(s, 0, 0), e;
    } else if (t.data) {
      const e = t.data.slice(0);
      for (let i = 0; i < e.length; i++)
        e instanceof Uint8Array || e instanceof Uint8ClampedArray ? e[i] = Math.floor(xi(e[i] / 255) * 255) : e[i] = xi(e[i]);
      return {
        data: e,
        width: t.width,
        height: t.height
      };
    } else
      return pt("ImageUtils.sRGBToLinear(): Unsupported image type. No color space conversion applied."), t;
  }
}
let Js = 0;
class Gs {
  /**
   * Constructs a new texture source.
   *
   * @param {any} [data=null] - The data definition of a texture.
   */
  constructor(t = null) {
    this.isTextureSource = !0, Object.defineProperty(this, "id", { value: Js++ }), this.uuid = hi(), this.data = t, this.dataReady = !0, this.version = 0;
  }
  /**
   * Returns the dimensions of the source into the given target vector.
   *
   * @param {(Vector2|Vector3)} target - The target object the result is written into.
   * @return {(Vector2|Vector3)} The dimensions of the source.
   */
  getSize(t) {
    const e = this.data;
    return typeof HTMLVideoElement < "u" && e instanceof HTMLVideoElement ? t.set(e.videoWidth, e.videoHeight, 0) : typeof VideoFrame < "u" && e instanceof VideoFrame ? t.set(e.displayWidth, e.displayHeight, 0) : e !== null ? t.set(e.width, e.height, e.depth || 0) : t.set(0, 0, 0), t;
  }
  /**
   * When the property is set to `true`, the engine allocates the memory
   * for the texture (if necessary) and triggers the actual texture upload
   * to the GPU next time the source is used.
   *
   * @type {boolean}
   * @default false
   * @param {boolean} value
   */
  set needsUpdate(t) {
    t === !0 && this.version++;
  }
  /**
   * Serializes the source into JSON.
   *
   * @param {?(Object|string)} meta - An optional value holding meta information about the serialization.
   * @return {Object} A JSON object representing the serialized source.
   * @see {@link ObjectLoader#parse}
   */
  toJSON(t) {
    const e = t === void 0 || typeof t == "string";
    if (!e && t.images[this.uuid] !== void 0)
      return t.images[this.uuid];
    const i = {
      uuid: this.uuid,
      url: ""
    }, s = this.data;
    if (s !== null) {
      let n;
      if (Array.isArray(s)) {
        n = [];
        for (let r = 0, a = s.length; r < a; r++)
          s[r].isDataTexture ? n.push(gi(s[r].image)) : n.push(gi(s[r]));
      } else
        n = gi(s);
      i.url = n;
    }
    return e || (t.images[this.uuid] = i), i;
  }
}
function gi(f) {
  return typeof HTMLImageElement < "u" && f instanceof HTMLImageElement || typeof HTMLCanvasElement < "u" && f instanceof HTMLCanvasElement || typeof ImageBitmap < "u" && f instanceof ImageBitmap ? $s.getDataURL(f) : f.data ? {
    data: Array.from(f.data),
    width: f.width,
    height: f.height,
    type: f.data.constructor.name
  } : (pt("Texture: Unable to serialize Texture."), {});
}
let Qs = 0;
const wi = /* @__PURE__ */ new S();
class Ht extends ci {
  /**
   * Constructs a new texture.
   *
   * @param {?Object} [image=Texture.DEFAULT_IMAGE] - The image holding the texture data.
   * @param {number} [mapping=Texture.DEFAULT_MAPPING] - The texture mapping.
   * @param {number} [wrapS=ClampToEdgeWrapping] - The wrapS value.
   * @param {number} [wrapT=ClampToEdgeWrapping] - The wrapT value.
   * @param {number} [magFilter=LinearFilter] - The mag filter value.
   * @param {number} [minFilter=LinearMipmapLinearFilter] - The min filter value.
   * @param {number} [format=RGBAFormat] - The texture format.
   * @param {number} [type=UnsignedByteType] - The texture type.
   * @param {number} [anisotropy=Texture.DEFAULT_ANISOTROPY] - The anisotropy value.
   * @param {string} [colorSpace=NoColorSpace] - The color space.
   */
  constructor(t = Ht.DEFAULT_IMAGE, e = Ht.DEFAULT_MAPPING, i = 1001, s = 1001, n = 1006, r = 1008, a = 1023, o = 1009, c = Ht.DEFAULT_ANISOTROPY, h = "") {
    super(), this.isTexture = !0, Object.defineProperty(this, "id", { value: Qs++ }), this.uuid = hi(), this.name = "", this.source = new Gs(t), this.mipmaps = [], this.mapping = e, this.channel = 0, this.wrapS = i, this.wrapT = s, this.magFilter = n, this.minFilter = r, this.anisotropy = c, this.format = a, this.internalFormat = null, this.type = o, this.offset = new Z(0, 0), this.repeat = new Z(1, 1), this.center = new Z(0, 0), this.rotation = 0, this.matrixAutoUpdate = !0, this.matrix = new Tt(), this.generateMipmaps = !0, this.premultiplyAlpha = !1, this.flipY = !0, this.unpackAlignment = 4, this.colorSpace = h, this.userData = {}, this.updateRanges = [], this.version = 0, this.onUpdate = null, this.renderTarget = null, this.isRenderTargetTexture = !1, this.isArrayTexture = !!(t && t.depth && t.depth > 1), this.pmremVersion = 0, this.normalized = !1;
  }
  /**
   * The width of the texture in pixels.
   */
  get width() {
    return this.source.getSize(wi).x;
  }
  /**
   * The height of the texture in pixels.
   */
  get height() {
    return this.source.getSize(wi).y;
  }
  /**
   * The depth of the texture in pixels.
   */
  get depth() {
    return this.source.getSize(wi).z;
  }
  /**
   * The image object holding the texture data.
   *
   * @type {?Object}
   */
  get image() {
    return this.source.data;
  }
  set image(t) {
    this.source.data = t;
  }
  /**
   * Updates the texture transformation matrix from the properties {@link Texture#offset},
   * {@link Texture#repeat}, {@link Texture#rotation}, and {@link Texture#center}.
   */
  updateMatrix() {
    this.matrix.setUvTransform(this.offset.x, this.offset.y, this.repeat.x, this.repeat.y, this.rotation, this.center.x, this.center.y);
  }
  /**
   * Adds a range of data in the data texture to be updated on the GPU.
   *
   * @param {number} start - Position at which to start update.
   * @param {number} count - The number of components to update.
   */
  addUpdateRange(t, e) {
    this.updateRanges.push({ start: t, count: e });
  }
  /**
   * Clears the update ranges.
   */
  clearUpdateRanges() {
    this.updateRanges.length = 0;
  }
  /**
   * Returns a new texture with copied values from this instance.
   *
   * @return {Texture} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Copies the values of the given texture to this instance.
   *
   * @param {Texture} source - The texture to copy.
   * @return {Texture} A reference to this instance.
   */
  copy(t) {
    return this.name = t.name, this.source = t.source, this.mipmaps = t.mipmaps.slice(0), this.mapping = t.mapping, this.channel = t.channel, this.wrapS = t.wrapS, this.wrapT = t.wrapT, this.magFilter = t.magFilter, this.minFilter = t.minFilter, this.anisotropy = t.anisotropy, this.format = t.format, this.internalFormat = t.internalFormat, this.type = t.type, this.normalized = t.normalized, this.offset.copy(t.offset), this.repeat.copy(t.repeat), this.center.copy(t.center), this.rotation = t.rotation, this.matrixAutoUpdate = t.matrixAutoUpdate, this.matrix.copy(t.matrix), this.generateMipmaps = t.generateMipmaps, this.premultiplyAlpha = t.premultiplyAlpha, this.flipY = t.flipY, this.unpackAlignment = t.unpackAlignment, this.colorSpace = t.colorSpace, this.renderTarget = t.renderTarget, this.isRenderTargetTexture = t.isRenderTargetTexture, this.isArrayTexture = t.isArrayTexture, this.userData = JSON.parse(JSON.stringify(t.userData)), this.needsUpdate = !0, this;
  }
  /**
   * Sets this texture's properties based on `values`.
   * @param {Object} values - A container with texture parameters.
   */
  setValues(t) {
    for (const e in t) {
      const i = t[e];
      if (i === void 0) {
        pt(`Texture.setValues(): parameter '${e}' has value of undefined.`);
        continue;
      }
      const s = this[e];
      if (s === void 0) {
        pt(`Texture.setValues(): property '${e}' does not exist.`);
        continue;
      }
      s && i && s.isVector2 && i.isVector2 || s && i && s.isVector3 && i.isVector3 || s && i && s.isMatrix3 && i.isMatrix3 ? s.copy(i) : this[e] = i;
    }
  }
  /**
   * Serializes the texture into JSON.
   *
   * @param {?(Object|string)} meta - An optional value holding meta information about the serialization.
   * @return {Object} A JSON object representing the serialized texture.
   * @see {@link ObjectLoader#parse}
   */
  toJSON(t) {
    const e = t === void 0 || typeof t == "string";
    if (!e && t.textures[this.uuid] !== void 0)
      return t.textures[this.uuid];
    const i = {
      metadata: {
        version: 4.7,
        type: "Texture",
        generator: "Texture.toJSON"
      },
      uuid: this.uuid,
      name: this.name,
      image: this.source.toJSON(t).uuid,
      mapping: this.mapping,
      channel: this.channel,
      repeat: [this.repeat.x, this.repeat.y],
      offset: [this.offset.x, this.offset.y],
      center: [this.center.x, this.center.y],
      rotation: this.rotation,
      wrap: [this.wrapS, this.wrapT],
      format: this.format,
      internalFormat: this.internalFormat,
      type: this.type,
      normalized: this.normalized,
      colorSpace: this.colorSpace,
      minFilter: this.minFilter,
      magFilter: this.magFilter,
      anisotropy: this.anisotropy,
      flipY: this.flipY,
      generateMipmaps: this.generateMipmaps,
      premultiplyAlpha: this.premultiplyAlpha,
      unpackAlignment: this.unpackAlignment
    };
    return Object.keys(this.userData).length > 0 && (i.userData = this.userData), e || (t.textures[this.uuid] = i), i;
  }
  /**
   * Frees the GPU-related resources allocated by this instance. Call this
   * method whenever this instance is no longer used in your app.
   *
   * @fires Texture#dispose
   */
  dispose() {
    this.dispatchEvent({ type: "dispose" });
  }
  /**
   * Transforms the given uv vector with the textures uv transformation matrix.
   *
   * @param {Vector2} uv - The uv vector.
   * @return {Vector2} The transformed uv vector.
   */
  transformUv(t) {
    if (this.mapping !== 300) return t;
    if (t.applyMatrix3(this.matrix), t.x < 0 || t.x > 1)
      switch (this.wrapS) {
        case 1e3:
          t.x = t.x - Math.floor(t.x);
          break;
        case 1001:
          t.x = t.x < 0 ? 0 : 1;
          break;
        case 1002:
          Math.abs(Math.floor(t.x) % 2) === 1 ? t.x = Math.ceil(t.x) - t.x : t.x = t.x - Math.floor(t.x);
          break;
      }
    if (t.y < 0 || t.y > 1)
      switch (this.wrapT) {
        case 1e3:
          t.y = t.y - Math.floor(t.y);
          break;
        case 1001:
          t.y = t.y < 0 ? 0 : 1;
          break;
        case 1002:
          Math.abs(Math.floor(t.y) % 2) === 1 ? t.y = Math.ceil(t.y) - t.y : t.y = t.y - Math.floor(t.y);
          break;
      }
    return this.flipY && (t.y = 1 - t.y), t;
  }
  /**
   * Setting this property to `true` indicates the engine the texture
   * must be updated in the next render. This triggers a texture upload
   * to the GPU and ensures correct texture parameter configuration.
   *
   * @type {boolean}
   * @default false
   * @param {boolean} value
   */
  set needsUpdate(t) {
    t === !0 && (this.version++, this.source.needsUpdate = !0);
  }
  /**
   * Setting this property to `true` indicates the engine the PMREM
   * must be regenerated.
   *
   * @type {boolean}
   * @default false
   * @param {boolean} value
   */
  set needsPMREMUpdate(t) {
    t === !0 && this.pmremVersion++;
  }
}
Ht.DEFAULT_IMAGE = null;
Ht.DEFAULT_MAPPING = 300;
Ht.DEFAULT_ANISOTROPY = 1;
class Ve {
  static {
    Ve.prototype.isVector4 = !0;
  }
  /**
   * Constructs a new 4D vector.
   *
   * @param {number} [x=0] - The x value of this vector.
   * @param {number} [y=0] - The y value of this vector.
   * @param {number} [z=0] - The z value of this vector.
   * @param {number} [w=1] - The w value of this vector.
   */
  constructor(t = 0, e = 0, i = 0, s = 1) {
    this.x = t, this.y = e, this.z = i, this.w = s;
  }
  /**
   * Alias for {@link Vector4#z}.
   *
   * @type {number}
   */
  get width() {
    return this.z;
  }
  set width(t) {
    this.z = t;
  }
  /**
   * Alias for {@link Vector4#w}.
   *
   * @type {number}
   */
  get height() {
    return this.w;
  }
  set height(t) {
    this.w = t;
  }
  /**
   * Sets the vector components.
   *
   * @param {number} x - The value of the x component.
   * @param {number} y - The value of the y component.
   * @param {number} z - The value of the z component.
   * @param {number} w - The value of the w component.
   * @return {Vector4} A reference to this vector.
   */
  set(t, e, i, s) {
    return this.x = t, this.y = e, this.z = i, this.w = s, this;
  }
  /**
   * Sets the vector components to the same value.
   *
   * @param {number} scalar - The value to set for all vector components.
   * @return {Vector4} A reference to this vector.
   */
  setScalar(t) {
    return this.x = t, this.y = t, this.z = t, this.w = t, this;
  }
  /**
   * Sets the vector's x component to the given value
   *
   * @param {number} x - The value to set.
   * @return {Vector4} A reference to this vector.
   */
  setX(t) {
    return this.x = t, this;
  }
  /**
   * Sets the vector's y component to the given value
   *
   * @param {number} y - The value to set.
   * @return {Vector4} A reference to this vector.
   */
  setY(t) {
    return this.y = t, this;
  }
  /**
   * Sets the vector's z component to the given value
   *
   * @param {number} z - The value to set.
   * @return {Vector4} A reference to this vector.
   */
  setZ(t) {
    return this.z = t, this;
  }
  /**
   * Sets the vector's w component to the given value
   *
   * @param {number} w - The value to set.
   * @return {Vector4} A reference to this vector.
   */
  setW(t) {
    return this.w = t, this;
  }
  /**
   * Allows to set a vector component with an index.
   *
   * @param {number} index - The component index. `0` equals to x, `1` equals to y,
   * `2` equals to z, `3` equals to w.
   * @param {number} value - The value to set.
   * @return {Vector4} A reference to this vector.
   */
  setComponent(t, e) {
    switch (t) {
      case 0:
        this.x = e;
        break;
      case 1:
        this.y = e;
        break;
      case 2:
        this.z = e;
        break;
      case 3:
        this.w = e;
        break;
      default:
        throw new Error("THREE.Vector4: index is out of range: " + t);
    }
    return this;
  }
  /**
   * Returns the value of the vector component which matches the given index.
   *
   * @param {number} index - The component index. `0` equals to x, `1` equals to y,
   * `2` equals to z, `3` equals to w.
   * @return {number} A vector component value.
   */
  getComponent(t) {
    switch (t) {
      case 0:
        return this.x;
      case 1:
        return this.y;
      case 2:
        return this.z;
      case 3:
        return this.w;
      default:
        throw new Error("THREE.Vector4: index is out of range: " + t);
    }
  }
  /**
   * Returns a new vector with copied values from this instance.
   *
   * @return {Vector4} A clone of this instance.
   */
  clone() {
    return new this.constructor(this.x, this.y, this.z, this.w);
  }
  /**
   * Copies the values of the given vector to this instance.
   *
   * @param {Vector3|Vector4} v - The vector to copy.
   * @return {Vector4} A reference to this vector.
   */
  copy(t) {
    return this.x = t.x, this.y = t.y, this.z = t.z, this.w = t.w !== void 0 ? t.w : 1, this;
  }
  /**
   * Adds the given vector to this instance.
   *
   * @param {Vector4} v - The vector to add.
   * @return {Vector4} A reference to this vector.
   */
  add(t) {
    return this.x += t.x, this.y += t.y, this.z += t.z, this.w += t.w, this;
  }
  /**
   * Adds the given scalar value to all components of this instance.
   *
   * @param {number} s - The scalar to add.
   * @return {Vector4} A reference to this vector.
   */
  addScalar(t) {
    return this.x += t, this.y += t, this.z += t, this.w += t, this;
  }
  /**
   * Adds the given vectors and stores the result in this instance.
   *
   * @param {Vector4} a - The first vector.
   * @param {Vector4} b - The second vector.
   * @return {Vector4} A reference to this vector.
   */
  addVectors(t, e) {
    return this.x = t.x + e.x, this.y = t.y + e.y, this.z = t.z + e.z, this.w = t.w + e.w, this;
  }
  /**
   * Adds the given vector scaled by the given factor to this instance.
   *
   * @param {Vector4} v - The vector.
   * @param {number} s - The factor that scales `v`.
   * @return {Vector4} A reference to this vector.
   */
  addScaledVector(t, e) {
    return this.x += t.x * e, this.y += t.y * e, this.z += t.z * e, this.w += t.w * e, this;
  }
  /**
   * Subtracts the given vector from this instance.
   *
   * @param {Vector4} v - The vector to subtract.
   * @return {Vector4} A reference to this vector.
   */
  sub(t) {
    return this.x -= t.x, this.y -= t.y, this.z -= t.z, this.w -= t.w, this;
  }
  /**
   * Subtracts the given scalar value from all components of this instance.
   *
   * @param {number} s - The scalar to subtract.
   * @return {Vector4} A reference to this vector.
   */
  subScalar(t) {
    return this.x -= t, this.y -= t, this.z -= t, this.w -= t, this;
  }
  /**
   * Subtracts the given vectors and stores the result in this instance.
   *
   * @param {Vector4} a - The first vector.
   * @param {Vector4} b - The second vector.
   * @return {Vector4} A reference to this vector.
   */
  subVectors(t, e) {
    return this.x = t.x - e.x, this.y = t.y - e.y, this.z = t.z - e.z, this.w = t.w - e.w, this;
  }
  /**
   * Multiplies the given vector with this instance.
   *
   * @param {Vector4} v - The vector to multiply.
   * @return {Vector4} A reference to this vector.
   */
  multiply(t) {
    return this.x *= t.x, this.y *= t.y, this.z *= t.z, this.w *= t.w, this;
  }
  /**
   * Multiplies the given scalar value with all components of this instance.
   *
   * @param {number} scalar - The scalar to multiply.
   * @return {Vector4} A reference to this vector.
   */
  multiplyScalar(t) {
    return this.x *= t, this.y *= t, this.z *= t, this.w *= t, this;
  }
  /**
   * Multiplies this vector with the given 4x4 matrix.
   *
   * @param {Matrix4} m - The 4x4 matrix.
   * @return {Vector4} A reference to this vector.
   */
  applyMatrix4(t) {
    const e = this.x, i = this.y, s = this.z, n = this.w, r = t.elements;
    return this.x = r[0] * e + r[4] * i + r[8] * s + r[12] * n, this.y = r[1] * e + r[5] * i + r[9] * s + r[13] * n, this.z = r[2] * e + r[6] * i + r[10] * s + r[14] * n, this.w = r[3] * e + r[7] * i + r[11] * s + r[15] * n, this;
  }
  /**
   * Divides this instance by the given vector.
   *
   * @param {Vector4} v - The vector to divide.
   * @return {Vector4} A reference to this vector.
   */
  divide(t) {
    return this.x /= t.x, this.y /= t.y, this.z /= t.z, this.w /= t.w, this;
  }
  /**
   * Divides this vector by the given scalar.
   *
   * @param {number} scalar - The scalar to divide.
   * @return {Vector4} A reference to this vector.
   */
  divideScalar(t) {
    return this.multiplyScalar(1 / t);
  }
  /**
   * Sets the x, y and z components of this
   * vector to the quaternion's axis and w to the angle.
   *
   * @param {Quaternion} q - The Quaternion to set.
   * @return {Vector4} A reference to this vector.
   */
  setAxisAngleFromQuaternion(t) {
    this.w = 2 * Math.acos(t.w);
    const e = Math.sqrt(1 - t.w * t.w);
    return e < 1e-4 ? (this.x = 1, this.y = 0, this.z = 0) : (this.x = t.x / e, this.y = t.y / e, this.z = t.z / e), this;
  }
  /**
   * Sets the x, y and z components of this
   * vector to the axis of rotation and w to the angle.
   *
   * @param {Matrix4} m - A 4x4 matrix of which the upper left 3x3 matrix is a pure rotation matrix.
   * @return {Vector4} A reference to this vector.
   */
  setAxisAngleFromRotationMatrix(t) {
    let e, i, s, n;
    const o = t.elements, c = o[0], h = o[4], l = o[8], u = o[1], d = o[5], y = o[9], m = o[2], z = o[6], b = o[10];
    if (Math.abs(h - u) < 0.01 && Math.abs(l - m) < 0.01 && Math.abs(y - z) < 0.01) {
      if (Math.abs(h + u) < 0.1 && Math.abs(l + m) < 0.1 && Math.abs(y + z) < 0.1 && Math.abs(c + d + b - 3) < 0.1)
        return this.set(1, 0, 0, 0), this;
      e = Math.PI;
      const w = (c + 1) / 2, x = (d + 1) / 2, g = (b + 1) / 2, B = (h + u) / 4, _ = (l + m) / 4, M = (y + z) / 4;
      return w > x && w > g ? w < 0.01 ? (i = 0, s = 0.707106781, n = 0.707106781) : (i = Math.sqrt(w), s = B / i, n = _ / i) : x > g ? x < 0.01 ? (i = 0.707106781, s = 0, n = 0.707106781) : (s = Math.sqrt(x), i = B / s, n = M / s) : g < 0.01 ? (i = 0.707106781, s = 0.707106781, n = 0) : (n = Math.sqrt(g), i = _ / n, s = M / n), this.set(i, s, n, e), this;
    }
    let p = Math.sqrt((z - y) * (z - y) + (l - m) * (l - m) + (u - h) * (u - h));
    return Math.abs(p) < 1e-3 && (p = 1), this.x = (z - y) / p, this.y = (l - m) / p, this.z = (u - h) / p, this.w = Math.acos((c + d + b - 1) / 2), this;
  }
  /**
   * Sets the vector components to the position elements of the
   * given transformation matrix.
   *
   * @param {Matrix4} m - The 4x4 matrix.
   * @return {Vector4} A reference to this vector.
   */
  setFromMatrixPosition(t) {
    const e = t.elements;
    return this.x = e[12], this.y = e[13], this.z = e[14], this.w = e[15], this;
  }
  /**
   * If this vector's x, y, z or w value is greater than the given vector's x, y, z or w
   * value, replace that value with the corresponding min value.
   *
   * @param {Vector4} v - The vector.
   * @return {Vector4} A reference to this vector.
   */
  min(t) {
    return this.x = Math.min(this.x, t.x), this.y = Math.min(this.y, t.y), this.z = Math.min(this.z, t.z), this.w = Math.min(this.w, t.w), this;
  }
  /**
   * If this vector's x, y, z or w value is less than the given vector's x, y, z or w
   * value, replace that value with the corresponding max value.
   *
   * @param {Vector4} v - The vector.
   * @return {Vector4} A reference to this vector.
   */
  max(t) {
    return this.x = Math.max(this.x, t.x), this.y = Math.max(this.y, t.y), this.z = Math.max(this.z, t.z), this.w = Math.max(this.w, t.w), this;
  }
  /**
   * If this vector's x, y, z or w value is greater than the max vector's x, y, z or w
   * value, it is replaced by the corresponding value.
   * If this vector's x, y, z or w value is less than the min vector's x, y, z or w value,
   * it is replaced by the corresponding value.
   *
   * @param {Vector4} min - The minimum x, y and z values.
   * @param {Vector4} max - The maximum x, y and z values in the desired range.
   * @return {Vector4} A reference to this vector.
   */
  clamp(t, e) {
    return this.x = k(this.x, t.x, e.x), this.y = k(this.y, t.y, e.y), this.z = k(this.z, t.z, e.z), this.w = k(this.w, t.w, e.w), this;
  }
  /**
   * If this vector's x, y, z or w values are greater than the max value, they are
   * replaced by the max value.
   * If this vector's x, y, z or w values are less than the min value, they are
   * replaced by the min value.
   *
   * @param {number} minVal - The minimum value the components will be clamped to.
   * @param {number} maxVal - The maximum value the components will be clamped to.
   * @return {Vector4} A reference to this vector.
   */
  clampScalar(t, e) {
    return this.x = k(this.x, t, e), this.y = k(this.y, t, e), this.z = k(this.z, t, e), this.w = k(this.w, t, e), this;
  }
  /**
   * If this vector's length is greater than the max value, it is replaced by
   * the max value.
   * If this vector's length is less than the min value, it is replaced by the
   * min value.
   *
   * @param {number} min - The minimum value the vector length will be clamped to.
   * @param {number} max - The maximum value the vector length will be clamped to.
   * @return {Vector4} A reference to this vector.
   */
  clampLength(t, e) {
    const i = this.length();
    return this.divideScalar(i || 1).multiplyScalar(k(i, t, e));
  }
  /**
   * The components of this vector are rounded down to the nearest integer value.
   *
   * @return {Vector4} A reference to this vector.
   */
  floor() {
    return this.x = Math.floor(this.x), this.y = Math.floor(this.y), this.z = Math.floor(this.z), this.w = Math.floor(this.w), this;
  }
  /**
   * The components of this vector are rounded up to the nearest integer value.
   *
   * @return {Vector4} A reference to this vector.
   */
  ceil() {
    return this.x = Math.ceil(this.x), this.y = Math.ceil(this.y), this.z = Math.ceil(this.z), this.w = Math.ceil(this.w), this;
  }
  /**
   * The components of this vector are rounded to the nearest integer value
   *
   * @return {Vector4} A reference to this vector.
   */
  round() {
    return this.x = Math.round(this.x), this.y = Math.round(this.y), this.z = Math.round(this.z), this.w = Math.round(this.w), this;
  }
  /**
   * The components of this vector are rounded towards zero (up if negative,
   * down if positive) to an integer value.
   *
   * @return {Vector4} A reference to this vector.
   */
  roundToZero() {
    return this.x = Math.trunc(this.x), this.y = Math.trunc(this.y), this.z = Math.trunc(this.z), this.w = Math.trunc(this.w), this;
  }
  /**
   * Inverts this vector - i.e. sets x = -x, y = -y, z = -z, w = -w.
   *
   * @return {Vector4} A reference to this vector.
   */
  negate() {
    return this.x = -this.x, this.y = -this.y, this.z = -this.z, this.w = -this.w, this;
  }
  /**
   * Calculates the dot product of the given vector with this instance.
   *
   * @param {Vector4} v - The vector to compute the dot product with.
   * @return {number} The result of the dot product.
   */
  dot(t) {
    return this.x * t.x + this.y * t.y + this.z * t.z + this.w * t.w;
  }
  /**
   * Computes the square of the Euclidean length (straight-line length) from
   * (0, 0, 0, 0) to (x, y, z, w). If you are comparing the lengths of vectors, you should
   * compare the length squared instead as it is slightly more efficient to calculate.
   *
   * @return {number} The square length of this vector.
   */
  lengthSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w;
  }
  /**
   * Computes the  Euclidean length (straight-line length) from (0, 0, 0, 0) to (x, y, z, w).
   *
   * @return {number} The length of this vector.
   */
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
  }
  /**
   * Computes the Manhattan length of this vector.
   *
   * @return {number} The length of this vector.
   */
  manhattanLength() {
    return Math.abs(this.x) + Math.abs(this.y) + Math.abs(this.z) + Math.abs(this.w);
  }
  /**
   * Converts this vector to a unit vector - that is, sets it equal to a vector
   * with the same direction as this one, but with a vector length of `1`.
   *
   * @return {Vector4} A reference to this vector.
   */
  normalize() {
    return this.divideScalar(this.length() || 1);
  }
  /**
   * Sets this vector to a vector with the same direction as this one, but
   * with the specified length.
   *
   * @param {number} length - The new length of this vector.
   * @return {Vector4} A reference to this vector.
   */
  setLength(t) {
    return this.normalize().multiplyScalar(t);
  }
  /**
   * Linearly interpolates between the given vector and this instance, where
   * alpha is the percent distance along the line - alpha = 0 will be this
   * vector, and alpha = 1 will be the given one.
   *
   * @param {Vector4} v - The vector to interpolate towards.
   * @param {number} alpha - The interpolation factor, typically in the closed interval `[0, 1]`.
   * @return {Vector4} A reference to this vector.
   */
  lerp(t, e) {
    return this.x += (t.x - this.x) * e, this.y += (t.y - this.y) * e, this.z += (t.z - this.z) * e, this.w += (t.w - this.w) * e, this;
  }
  /**
   * Linearly interpolates between the given vectors, where alpha is the percent
   * distance along the line - alpha = 0 will be first vector, and alpha = 1 will
   * be the second one. The result is stored in this instance.
   *
   * @param {Vector4} v1 - The first vector.
   * @param {Vector4} v2 - The second vector.
   * @param {number} alpha - The interpolation factor, typically in the closed interval `[0, 1]`.
   * @return {Vector4} A reference to this vector.
   */
  lerpVectors(t, e, i) {
    return this.x = t.x + (e.x - t.x) * i, this.y = t.y + (e.y - t.y) * i, this.z = t.z + (e.z - t.z) * i, this.w = t.w + (e.w - t.w) * i, this;
  }
  /**
   * Returns `true` if this vector is equal with the given one.
   *
   * @param {Vector4} v - The vector to test for equality.
   * @return {boolean} Whether this vector is equal with the given one.
   */
  equals(t) {
    return t.x === this.x && t.y === this.y && t.z === this.z && t.w === this.w;
  }
  /**
   * Sets this vector's x value to be `array[ offset ]`, y value to be `array[ offset + 1 ]`,
   * z value to be `array[ offset + 2 ]`, w value to be `array[ offset + 3 ]`.
   *
   * @param {Array<number>} array - An array holding the vector component values.
   * @param {number} [offset=0] - The offset into the array.
   * @return {Vector4} A reference to this vector.
   */
  fromArray(t, e = 0) {
    return this.x = t[e], this.y = t[e + 1], this.z = t[e + 2], this.w = t[e + 3], this;
  }
  /**
   * Writes the components of this vector to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number>} [array=[]] - The target array holding the vector components.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number>} The vector components.
   */
  toArray(t = [], e = 0) {
    return t[e] = this.x, t[e + 1] = this.y, t[e + 2] = this.z, t[e + 3] = this.w, t;
  }
  /**
   * Sets the components of this vector from the given buffer attribute.
   *
   * @param {BufferAttribute} attribute - The buffer attribute holding vector data.
   * @param {number} index - The index into the attribute.
   * @return {Vector4} A reference to this vector.
   */
  fromBufferAttribute(t, e) {
    return this.x = t.getX(e), this.y = t.getY(e), this.z = t.getZ(e), this.w = t.getW(e), this;
  }
  /**
   * Sets each component of this vector to a pseudo-random value between `0` and
   * `1`, excluding `1`.
   *
   * @return {Vector4} A reference to this vector.
   */
  random() {
    return this.x = Math.random(), this.y = Math.random(), this.z = Math.random(), this.w = Math.random(), this;
  }
  *[Symbol.iterator]() {
    yield this.x, yield this.y, yield this.z, yield this.w;
  }
}
class H {
  static {
    H.prototype.isMatrix4 = !0;
  }
  /**
   * Constructs a new 4x4 matrix. The arguments are supposed to be
   * in row-major order. If no arguments are provided, the constructor
   * initializes the matrix as an identity matrix.
   *
   * @param {number} [n11] - 1-1 matrix element.
   * @param {number} [n12] - 1-2 matrix element.
   * @param {number} [n13] - 1-3 matrix element.
   * @param {number} [n14] - 1-4 matrix element.
   * @param {number} [n21] - 2-1 matrix element.
   * @param {number} [n22] - 2-2 matrix element.
   * @param {number} [n23] - 2-3 matrix element.
   * @param {number} [n24] - 2-4 matrix element.
   * @param {number} [n31] - 3-1 matrix element.
   * @param {number} [n32] - 3-2 matrix element.
   * @param {number} [n33] - 3-3 matrix element.
   * @param {number} [n34] - 3-4 matrix element.
   * @param {number} [n41] - 4-1 matrix element.
   * @param {number} [n42] - 4-2 matrix element.
   * @param {number} [n43] - 4-3 matrix element.
   * @param {number} [n44] - 4-4 matrix element.
   */
  constructor(t, e, i, s, n, r, a, o, c, h, l, u, d, y, m, z) {
    this.elements = [
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1
    ], t !== void 0 && this.set(t, e, i, s, n, r, a, o, c, h, l, u, d, y, m, z);
  }
  /**
   * Sets the elements of the matrix.The arguments are supposed to be
   * in row-major order.
   *
   * @param {number} [n11] - 1-1 matrix element.
   * @param {number} [n12] - 1-2 matrix element.
   * @param {number} [n13] - 1-3 matrix element.
   * @param {number} [n14] - 1-4 matrix element.
   * @param {number} [n21] - 2-1 matrix element.
   * @param {number} [n22] - 2-2 matrix element.
   * @param {number} [n23] - 2-3 matrix element.
   * @param {number} [n24] - 2-4 matrix element.
   * @param {number} [n31] - 3-1 matrix element.
   * @param {number} [n32] - 3-2 matrix element.
   * @param {number} [n33] - 3-3 matrix element.
   * @param {number} [n34] - 3-4 matrix element.
   * @param {number} [n41] - 4-1 matrix element.
   * @param {number} [n42] - 4-2 matrix element.
   * @param {number} [n43] - 4-3 matrix element.
   * @param {number} [n44] - 4-4 matrix element.
   * @return {Matrix4} A reference to this matrix.
   */
  set(t, e, i, s, n, r, a, o, c, h, l, u, d, y, m, z) {
    const b = this.elements;
    return b[0] = t, b[4] = e, b[8] = i, b[12] = s, b[1] = n, b[5] = r, b[9] = a, b[13] = o, b[2] = c, b[6] = h, b[10] = l, b[14] = u, b[3] = d, b[7] = y, b[11] = m, b[15] = z, this;
  }
  /**
   * Sets this matrix to the 4x4 identity matrix.
   *
   * @return {Matrix4} A reference to this matrix.
   */
  identity() {
    return this.set(
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Returns a matrix with copied values from this instance.
   *
   * @return {Matrix4} A clone of this instance.
   */
  clone() {
    return new H().fromArray(this.elements);
  }
  /**
   * Copies the values of the given matrix to this instance.
   *
   * @param {Matrix4} m - The matrix to copy.
   * @return {Matrix4} A reference to this matrix.
   */
  copy(t) {
    const e = this.elements, i = t.elements;
    return e[0] = i[0], e[1] = i[1], e[2] = i[2], e[3] = i[3], e[4] = i[4], e[5] = i[5], e[6] = i[6], e[7] = i[7], e[8] = i[8], e[9] = i[9], e[10] = i[10], e[11] = i[11], e[12] = i[12], e[13] = i[13], e[14] = i[14], e[15] = i[15], this;
  }
  /**
   * Copies the translation component of the given matrix
   * into this matrix's translation component.
   *
   * @param {Matrix4} m - The matrix to copy the translation component.
   * @return {Matrix4} A reference to this matrix.
   */
  copyPosition(t) {
    const e = this.elements, i = t.elements;
    return e[12] = i[12], e[13] = i[13], e[14] = i[14], this;
  }
  /**
   * Set the upper 3x3 elements of this matrix to the values of given 3x3 matrix.
   *
   * @param {Matrix3} m - The 3x3 matrix.
   * @return {Matrix4} A reference to this matrix.
   */
  setFromMatrix3(t) {
    const e = t.elements;
    return this.set(
      e[0],
      e[3],
      e[6],
      0,
      e[1],
      e[4],
      e[7],
      0,
      e[2],
      e[5],
      e[8],
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Extracts the basis vectors of this matrix into the three vectors provided.
   *
   * @param {Vector3} xAxis - The basis's x axis.
   * @param {Vector3} yAxis - The basis's y axis.
   * @param {Vector3} zAxis - The basis's z axis.
   * @return {Matrix4} A reference to this matrix.
   */
  extractBasis(t, e, i) {
    return this.determinantAffine() === 0 ? (t.set(1, 0, 0), e.set(0, 1, 0), i.set(0, 0, 1), this) : (t.setFromMatrixColumn(this, 0), e.setFromMatrixColumn(this, 1), i.setFromMatrixColumn(this, 2), this);
  }
  /**
   * Sets the given basis vectors to this matrix.
   *
   * @param {Vector3} xAxis - The basis's x axis.
   * @param {Vector3} yAxis - The basis's y axis.
   * @param {Vector3} zAxis - The basis's z axis.
   * @return {Matrix4} A reference to this matrix.
   */
  makeBasis(t, e, i) {
    return this.set(
      t.x,
      e.x,
      i.x,
      0,
      t.y,
      e.y,
      i.y,
      0,
      t.z,
      e.z,
      i.z,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Extracts the rotation component of the given matrix
   * into this matrix's rotation component.
   *
   * Note: This method does not support reflection matrices.
   *
   * @param {Matrix4} m - The matrix.
   * @return {Matrix4} A reference to this matrix.
   */
  extractRotation(t) {
    if (t.determinantAffine() === 0)
      return this.identity();
    const e = this.elements, i = t.elements, s = 1 / Jt.setFromMatrixColumn(t, 0).length(), n = 1 / Jt.setFromMatrixColumn(t, 1).length(), r = 1 / Jt.setFromMatrixColumn(t, 2).length();
    return e[0] = i[0] * s, e[1] = i[1] * s, e[2] = i[2] * s, e[3] = 0, e[4] = i[4] * n, e[5] = i[5] * n, e[6] = i[6] * n, e[7] = 0, e[8] = i[8] * r, e[9] = i[9] * r, e[10] = i[10] * r, e[11] = 0, e[12] = 0, e[13] = 0, e[14] = 0, e[15] = 1, this;
  }
  /**
   * Sets the rotation component (the upper left 3x3 matrix) of this matrix to
   * the rotation specified by the given Euler angles. The rest of
   * the matrix is set to the identity. Depending on the {@link Euler#order},
   * there are six possible outcomes. See [this page](https://en.wikipedia.org/wiki/Euler_angles#Rotation_matrix)
   * for a complete list.
   *
   * @param {Euler} euler - The Euler angles.
   * @return {Matrix4} A reference to this matrix.
   */
  makeRotationFromEuler(t) {
    const e = this.elements, i = t.x, s = t.y, n = t.z, r = Math.cos(i), a = Math.sin(i), o = Math.cos(s), c = Math.sin(s), h = Math.cos(n), l = Math.sin(n);
    if (t.order === "XYZ") {
      const u = r * h, d = r * l, y = a * h, m = a * l;
      e[0] = o * h, e[4] = -o * l, e[8] = c, e[1] = d + y * c, e[5] = u - m * c, e[9] = -a * o, e[2] = m - u * c, e[6] = y + d * c, e[10] = r * o;
    } else if (t.order === "YXZ") {
      const u = o * h, d = o * l, y = c * h, m = c * l;
      e[0] = u + m * a, e[4] = y * a - d, e[8] = r * c, e[1] = r * l, e[5] = r * h, e[9] = -a, e[2] = d * a - y, e[6] = m + u * a, e[10] = r * o;
    } else if (t.order === "ZXY") {
      const u = o * h, d = o * l, y = c * h, m = c * l;
      e[0] = u - m * a, e[4] = -r * l, e[8] = y + d * a, e[1] = d + y * a, e[5] = r * h, e[9] = m - u * a, e[2] = -r * c, e[6] = a, e[10] = r * o;
    } else if (t.order === "ZYX") {
      const u = r * h, d = r * l, y = a * h, m = a * l;
      e[0] = o * h, e[4] = y * c - d, e[8] = u * c + m, e[1] = o * l, e[5] = m * c + u, e[9] = d * c - y, e[2] = -c, e[6] = a * o, e[10] = r * o;
    } else if (t.order === "YZX") {
      const u = r * o, d = r * c, y = a * o, m = a * c;
      e[0] = o * h, e[4] = m - u * l, e[8] = y * l + d, e[1] = l, e[5] = r * h, e[9] = -a * h, e[2] = -c * h, e[6] = d * l + y, e[10] = u - m * l;
    } else if (t.order === "XZY") {
      const u = r * o, d = r * c, y = a * o, m = a * c;
      e[0] = o * h, e[4] = -l, e[8] = c * h, e[1] = u * l + m, e[5] = r * h, e[9] = d * l - y, e[2] = y * l - d, e[6] = a * h, e[10] = m * l + u;
    }
    return e[3] = 0, e[7] = 0, e[11] = 0, e[12] = 0, e[13] = 0, e[14] = 0, e[15] = 1, this;
  }
  /**
   * Sets the rotation component of this matrix to the rotation specified by
   * the given Quaternion as outlined [here](https://en.wikipedia.org/wiki/Rotation_matrix#Quaternion)
   * The rest of the matrix is set to the identity.
   *
   * @param {Quaternion} q - The Quaternion.
   * @return {Matrix4} A reference to this matrix.
   */
  makeRotationFromQuaternion(t) {
    return this.compose(js, t, Ks);
  }
  /**
   * Sets the rotation component of the transformation matrix, looking from `eye` towards
   * `target`, and oriented by the up-direction.
   *
   * @param {Vector3} eye - The eye vector.
   * @param {Vector3} target - The target vector.
   * @param {Vector3} up - The up vector.
   * @return {Matrix4} A reference to this matrix.
   */
  lookAt(t, e, i) {
    const s = this.elements;
    return et.subVectors(t, e), et.lengthSq() === 0 && (et.z = 1), et.normalize(), Pt.crossVectors(i, et), Pt.lengthSq() === 0 && (Math.abs(i.z) === 1 ? et.x += 1e-4 : et.z += 1e-4, et.normalize(), Pt.crossVectors(i, et)), Pt.normalize(), Re.crossVectors(et, Pt), s[0] = Pt.x, s[4] = Re.x, s[8] = et.x, s[1] = Pt.y, s[5] = Re.y, s[9] = et.y, s[2] = Pt.z, s[6] = Re.z, s[10] = et.z, this;
  }
  /**
   * Post-multiplies this matrix by the given 4x4 matrix.
   *
   * @param {Matrix4} m - The matrix to multiply with.
   * @return {Matrix4} A reference to this matrix.
   */
  multiply(t) {
    return this.multiplyMatrices(this, t);
  }
  /**
   * Pre-multiplies this matrix by the given 4x4 matrix.
   *
   * @param {Matrix4} m - The matrix to multiply with.
   * @return {Matrix4} A reference to this matrix.
   */
  premultiply(t) {
    return this.multiplyMatrices(t, this);
  }
  /**
   * Multiples the given 4x4 matrices and stores the result
   * in this matrix.
   *
   * @param {Matrix4} a - The first matrix.
   * @param {Matrix4} b - The second matrix.
   * @return {Matrix4} A reference to this matrix.
   */
  multiplyMatrices(t, e) {
    const i = t.elements, s = e.elements, n = this.elements, r = i[0], a = i[4], o = i[8], c = i[12], h = i[1], l = i[5], u = i[9], d = i[13], y = i[2], m = i[6], z = i[10], b = i[14], p = i[3], w = i[7], x = i[11], g = i[15], B = s[0], _ = s[4], M = s[8], P = s[12], A = s[1], C = s[5], T = s[9], E = s[13], I = s[2], V = s[6], F = s[10], U = s[14], K = s[3], ct = s[7], st = s[11], yt = s[15];
    return n[0] = r * B + a * A + o * I + c * K, n[4] = r * _ + a * C + o * V + c * ct, n[8] = r * M + a * T + o * F + c * st, n[12] = r * P + a * E + o * U + c * yt, n[1] = h * B + l * A + u * I + d * K, n[5] = h * _ + l * C + u * V + d * ct, n[9] = h * M + l * T + u * F + d * st, n[13] = h * P + l * E + u * U + d * yt, n[2] = y * B + m * A + z * I + b * K, n[6] = y * _ + m * C + z * V + b * ct, n[10] = y * M + m * T + z * F + b * st, n[14] = y * P + m * E + z * U + b * yt, n[3] = p * B + w * A + x * I + g * K, n[7] = p * _ + w * C + x * V + g * ct, n[11] = p * M + w * T + x * F + g * st, n[15] = p * P + w * E + x * U + g * yt, this;
  }
  /**
   * Multiplies every component of the matrix by the given scalar.
   *
   * @param {number} s - The scalar.
   * @return {Matrix4} A reference to this matrix.
   */
  multiplyScalar(t) {
    const e = this.elements;
    return e[0] *= t, e[4] *= t, e[8] *= t, e[12] *= t, e[1] *= t, e[5] *= t, e[9] *= t, e[13] *= t, e[2] *= t, e[6] *= t, e[10] *= t, e[14] *= t, e[3] *= t, e[7] *= t, e[11] *= t, e[15] *= t, this;
  }
  /**
   * Computes and returns the determinant of this matrix.
   *
   * @return {number} The determinant.
   */
  determinant() {
    const t = this.elements, e = t[0], i = t[4], s = t[8], n = t[12], r = t[1], a = t[5], o = t[9], c = t[13], h = t[2], l = t[6], u = t[10], d = t[14], y = t[3], m = t[7], z = t[11], b = t[15], p = o * d - c * u, w = a * d - c * l, x = a * u - o * l, g = r * d - c * h, B = r * u - o * h, _ = r * l - a * h;
    return e * (m * p - z * w + b * x) - i * (y * p - z * g + b * B) + s * (y * w - m * g + b * _) - n * (y * x - m * B + z * _);
  }
  /**
   * Computes and returns the determinant of the 4x4 matrix, but assumes the
   * matrix is affine, saving some computations.
   *
   * For affine matrices (like an object's world matrix), this value equals the
   * full 4x4 {@link Matrix4#determinant} but is cheaper to compute.
   *
   * Assumes the bottom row is [0, 0, 0, 1].
   *
   * @return {number} The determinant of the matrix.
   */
  determinantAffine() {
    const t = this.elements, e = t[0], i = t[4], s = t[8], n = t[1], r = t[5], a = t[9], o = t[2], c = t[6], h = t[10];
    return e * (r * h - a * c) - i * (n * h - a * o) + s * (n * c - r * o);
  }
  /**
   * Transposes this matrix in place.
   *
   * @return {Matrix4} A reference to this matrix.
   */
  transpose() {
    const t = this.elements;
    let e;
    return e = t[1], t[1] = t[4], t[4] = e, e = t[2], t[2] = t[8], t[8] = e, e = t[6], t[6] = t[9], t[9] = e, e = t[3], t[3] = t[12], t[12] = e, e = t[7], t[7] = t[13], t[13] = e, e = t[11], t[11] = t[14], t[14] = e, this;
  }
  /**
   * Sets the position component for this matrix from the given vector,
   * without affecting the rest of the matrix.
   *
   * @param {number|Vector3} x - The x component of the vector or alternatively the vector object.
   * @param {number} y - The y component of the vector.
   * @param {number} z - The z component of the vector.
   * @return {Matrix4} A reference to this matrix.
   */
  setPosition(t, e, i) {
    const s = this.elements;
    return t.isVector3 ? (s[12] = t.x, s[13] = t.y, s[14] = t.z) : (s[12] = t, s[13] = e, s[14] = i), this;
  }
  /**
   * Inverts this matrix, using the [analytic method](https://en.wikipedia.org/wiki/Invertible_matrix#Analytic_solution).
   * You can not invert with a determinant of zero. If you attempt this, the method produces
   * a zero matrix instead.
   *
   * @return {Matrix4} A reference to this matrix.
   */
  invert() {
    const t = this.elements, e = t[0], i = t[1], s = t[2], n = t[3], r = t[4], a = t[5], o = t[6], c = t[7], h = t[8], l = t[9], u = t[10], d = t[11], y = t[12], m = t[13], z = t[14], b = t[15], p = e * a - i * r, w = e * o - s * r, x = e * c - n * r, g = i * o - s * a, B = i * c - n * a, _ = s * c - n * o, M = h * m - l * y, P = h * z - u * y, A = h * b - d * y, C = l * z - u * m, T = l * b - d * m, E = u * b - d * z, I = p * E - w * T + x * C + g * A - B * P + _ * M;
    if (I === 0) return this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    const V = 1 / I;
    return t[0] = (a * E - o * T + c * C) * V, t[1] = (s * T - i * E - n * C) * V, t[2] = (m * _ - z * B + b * g) * V, t[3] = (u * B - l * _ - d * g) * V, t[4] = (o * A - r * E - c * P) * V, t[5] = (e * E - s * A + n * P) * V, t[6] = (z * x - y * _ - b * w) * V, t[7] = (h * _ - u * x + d * w) * V, t[8] = (r * T - a * A + c * M) * V, t[9] = (i * A - e * T - n * M) * V, t[10] = (y * B - m * x + b * p) * V, t[11] = (l * x - h * B - d * p) * V, t[12] = (a * P - r * C - o * M) * V, t[13] = (e * C - i * P + s * M) * V, t[14] = (m * w - y * g - z * p) * V, t[15] = (h * g - l * w + u * p) * V, this;
  }
  /**
   * Scales each of the first three columns of this matrix by the corresponding component of the given vector.
   *
   * @param {Vector3} v - The scale vector.
   * @return {Matrix4} A reference to this matrix.
   */
  scale(t) {
    const e = this.elements, i = t.x, s = t.y, n = t.z;
    return e[0] *= i, e[4] *= s, e[8] *= n, e[1] *= i, e[5] *= s, e[9] *= n, e[2] *= i, e[6] *= s, e[10] *= n, e[3] *= i, e[7] *= s, e[11] *= n, this;
  }
  /**
   * Gets the maximum scale value of the three axes.
   *
   * @return {number} The maximum scale.
   */
  getMaxScaleOnAxis() {
    const t = this.elements, e = t[0] * t[0] + t[1] * t[1] + t[2] * t[2], i = t[4] * t[4] + t[5] * t[5] + t[6] * t[6], s = t[8] * t[8] + t[9] * t[9] + t[10] * t[10];
    return Math.sqrt(Math.max(e, i, s));
  }
  /**
   * Sets this matrix as a translation transform from the given vector.
   *
   * @param {number|Vector3} x - The amount to translate in the X axis or alternatively a translation vector.
   * @param {number} y - The amount to translate in the Y axis.
   * @param {number} z - The amount to translate in the z axis.
   * @return {Matrix4} A reference to this matrix.
   */
  makeTranslation(t, e, i) {
    return t.isVector3 ? this.set(
      1,
      0,
      0,
      t.x,
      0,
      1,
      0,
      t.y,
      0,
      0,
      1,
      t.z,
      0,
      0,
      0,
      1
    ) : this.set(
      1,
      0,
      0,
      t,
      0,
      1,
      0,
      e,
      0,
      0,
      1,
      i,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a rotational transformation around the X axis by
   * the given angle.
   *
   * @param {number} theta - The rotation in radians.
   * @return {Matrix4} A reference to this matrix.
   */
  makeRotationX(t) {
    const e = Math.cos(t), i = Math.sin(t);
    return this.set(
      1,
      0,
      0,
      0,
      0,
      e,
      -i,
      0,
      0,
      i,
      e,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a rotational transformation around the Y axis by
   * the given angle.
   *
   * @param {number} theta - The rotation in radians.
   * @return {Matrix4} A reference to this matrix.
   */
  makeRotationY(t) {
    const e = Math.cos(t), i = Math.sin(t);
    return this.set(
      e,
      0,
      i,
      0,
      0,
      1,
      0,
      0,
      -i,
      0,
      e,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a rotational transformation around the Z axis by
   * the given angle.
   *
   * @param {number} theta - The rotation in radians.
   * @return {Matrix4} A reference to this matrix.
   */
  makeRotationZ(t) {
    const e = Math.cos(t), i = Math.sin(t);
    return this.set(
      e,
      -i,
      0,
      0,
      i,
      e,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a rotational transformation around the given axis by
   * the given angle.
   *
   * @param {Vector3} axis - The normalized rotation axis.
   * @param {number} angle - The rotation in radians.
   * @return {Matrix4} A reference to this matrix.
   */
  makeRotationAxis(t, e) {
    const i = Math.cos(e), s = Math.sin(e), n = 1 - i, r = t.x, a = t.y, o = t.z, c = n * r, h = n * a;
    return this.set(
      c * r + i,
      c * a - s * o,
      c * o + s * a,
      0,
      c * a + s * o,
      h * a + i,
      h * o - s * r,
      0,
      c * o - s * a,
      h * o + s * r,
      n * o * o + i,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a scale transformation.
   *
   * @param {number} x - The amount to scale in the X axis.
   * @param {number} y - The amount to scale in the Y axis.
   * @param {number} z - The amount to scale in the Z axis.
   * @return {Matrix4} A reference to this matrix.
   */
  makeScale(t, e, i) {
    return this.set(
      t,
      0,
      0,
      0,
      0,
      e,
      0,
      0,
      0,
      0,
      i,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix as a shear transformation.
   *
   * @param {number} xy - The amount to shear X by Y.
   * @param {number} xz - The amount to shear X by Z.
   * @param {number} yx - The amount to shear Y by X.
   * @param {number} yz - The amount to shear Y by Z.
   * @param {number} zx - The amount to shear Z by X.
   * @param {number} zy - The amount to shear Z by Y.
   * @return {Matrix4} A reference to this matrix.
   */
  makeShear(t, e, i, s, n, r) {
    return this.set(
      1,
      i,
      n,
      0,
      t,
      1,
      r,
      0,
      e,
      s,
      1,
      0,
      0,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets this matrix to the transformation composed of the given position,
   * rotation (Quaternion) and scale.
   *
   * @param {Vector3} position - The position vector.
   * @param {Quaternion} quaternion - The rotation as a Quaternion.
   * @param {Vector3} scale - The scale vector.
   * @return {Matrix4} A reference to this matrix.
   */
  compose(t, e, i) {
    const s = this.elements, n = e._x, r = e._y, a = e._z, o = e._w, c = n + n, h = r + r, l = a + a, u = n * c, d = n * h, y = n * l, m = r * h, z = r * l, b = a * l, p = o * c, w = o * h, x = o * l, g = i.x, B = i.y, _ = i.z;
    return s[0] = (1 - (m + b)) * g, s[1] = (d + x) * g, s[2] = (y - w) * g, s[3] = 0, s[4] = (d - x) * B, s[5] = (1 - (u + b)) * B, s[6] = (z + p) * B, s[7] = 0, s[8] = (y + w) * _, s[9] = (z - p) * _, s[10] = (1 - (u + m)) * _, s[11] = 0, s[12] = t.x, s[13] = t.y, s[14] = t.z, s[15] = 1, this;
  }
  /**
   * Decomposes this matrix into its position, rotation and scale components
   * and provides the result in the given objects.
   *
   * Note: Not all matrices are decomposable in this way. For example, if an
   * object has a non-uniformly scaled parent, then the object's world matrix
   * may not be decomposable, and this method may not be appropriate.
   *
   * @param {Vector3} position - The position vector.
   * @param {Quaternion} quaternion - The rotation as a Quaternion.
   * @param {Vector3} scale - The scale vector.
   * @return {Matrix4} A reference to this matrix.
   */
  decompose(t, e, i) {
    const s = this.elements;
    t.x = s[12], t.y = s[13], t.z = s[14];
    const n = this.determinantAffine();
    if (n === 0)
      return i.set(1, 1, 1), e.identity(), this;
    let r = Jt.set(s[0], s[1], s[2]).length();
    const a = Jt.set(s[4], s[5], s[6]).length(), o = Jt.set(s[8], s[9], s[10]).length();
    n < 0 && (r = -r), ht.copy(this);
    const c = 1 / r, h = 1 / a, l = 1 / o;
    return ht.elements[0] *= c, ht.elements[1] *= c, ht.elements[2] *= c, ht.elements[4] *= h, ht.elements[5] *= h, ht.elements[6] *= h, ht.elements[8] *= l, ht.elements[9] *= l, ht.elements[10] *= l, e.setFromRotationMatrix(ht), i.x = r, i.y = a, i.z = o, this;
  }
  /**
  	 * Creates a perspective projection matrix. This is used internally by
  	 * {@link PerspectiveCamera#updateProjectionMatrix}.
  
  	 * @param {number} left - Left boundary of the viewing frustum at the near plane.
  	 * @param {number} right - Right boundary of the viewing frustum at the near plane.
  	 * @param {number} top - Top boundary of the viewing frustum at the near plane.
  	 * @param {number} bottom - Bottom boundary of the viewing frustum at the near plane.
  	 * @param {number} near - The distance from the camera to the near plane.
  	 * @param {number} far - The distance from the camera to the far plane.
  	 * @param {(WebGLCoordinateSystem|WebGPUCoordinateSystem)} [coordinateSystem=WebGLCoordinateSystem] - The coordinate system.
  	 * @param {boolean} [reversedDepth=false] - Whether to use a reversed depth.
  	 * @return {Matrix4} A reference to this matrix.
  	 */
  makePerspective(t, e, i, s, n, r, a = 2e3, o = !1) {
    const c = this.elements, h = 2 * n / (e - t), l = 2 * n / (i - s), u = (e + t) / (e - t), d = (i + s) / (i - s);
    let y, m;
    if (o)
      y = n / (r - n), m = r * n / (r - n);
    else if (a === 2e3)
      y = -(r + n) / (r - n), m = -2 * r * n / (r - n);
    else if (a === 2001)
      y = -r / (r - n), m = -r * n / (r - n);
    else
      throw new Error("THREE.Matrix4.makePerspective(): Invalid coordinate system: " + a);
    return c[0] = h, c[4] = 0, c[8] = u, c[12] = 0, c[1] = 0, c[5] = l, c[9] = d, c[13] = 0, c[2] = 0, c[6] = 0, c[10] = y, c[14] = m, c[3] = 0, c[7] = 0, c[11] = -1, c[15] = 0, this;
  }
  /**
  	 * Creates a orthographic projection matrix. This is used internally by
  	 * {@link OrthographicCamera#updateProjectionMatrix}.
  
  	 * @param {number} left - Left boundary of the viewing frustum at the near plane.
  	 * @param {number} right - Right boundary of the viewing frustum at the near plane.
  	 * @param {number} top - Top boundary of the viewing frustum at the near plane.
  	 * @param {number} bottom - Bottom boundary of the viewing frustum at the near plane.
  	 * @param {number} near - The distance from the camera to the near plane.
  	 * @param {number} far - The distance from the camera to the far plane.
  	 * @param {(WebGLCoordinateSystem|WebGPUCoordinateSystem)} [coordinateSystem=WebGLCoordinateSystem] - The coordinate system.
  	 * @param {boolean} [reversedDepth=false] - Whether to use a reversed depth.
  	 * @return {Matrix4} A reference to this matrix.
  	 */
  makeOrthographic(t, e, i, s, n, r, a = 2e3, o = !1) {
    const c = this.elements, h = 2 / (e - t), l = 2 / (i - s), u = -(e + t) / (e - t), d = -(i + s) / (i - s);
    let y, m;
    if (o)
      y = 1 / (r - n), m = r / (r - n);
    else if (a === 2e3)
      y = -2 / (r - n), m = -(r + n) / (r - n);
    else if (a === 2001)
      y = -1 / (r - n), m = -n / (r - n);
    else
      throw new Error("THREE.Matrix4.makeOrthographic(): Invalid coordinate system: " + a);
    return c[0] = h, c[4] = 0, c[8] = 0, c[12] = u, c[1] = 0, c[5] = l, c[9] = 0, c[13] = d, c[2] = 0, c[6] = 0, c[10] = y, c[14] = m, c[3] = 0, c[7] = 0, c[11] = 0, c[15] = 1, this;
  }
  /**
   * Returns `true` if this matrix is equal with the given one.
   *
   * @param {Matrix4} matrix - The matrix to test for equality.
   * @return {boolean} Whether this matrix is equal with the given one.
   */
  equals(t) {
    const e = this.elements, i = t.elements;
    for (let s = 0; s < 16; s++)
      if (e[s] !== i[s]) return !1;
    return !0;
  }
  /**
   * Sets the elements of the matrix from the given array.
   *
   * @param {Array<number>} array - The matrix elements in column-major order.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Matrix4} A reference to this matrix.
   */
  fromArray(t, e = 0) {
    for (let i = 0; i < 16; i++)
      this.elements[i] = t[i + e];
    return this;
  }
  /**
   * Writes the elements of this matrix to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number>} [array=[]] - The target array holding the matrix elements in column-major order.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number>} The matrix elements in column-major order.
   */
  toArray(t = [], e = 0) {
    const i = this.elements;
    return t[e] = i[0], t[e + 1] = i[1], t[e + 2] = i[2], t[e + 3] = i[3], t[e + 4] = i[4], t[e + 5] = i[5], t[e + 6] = i[6], t[e + 7] = i[7], t[e + 8] = i[8], t[e + 9] = i[9], t[e + 10] = i[10], t[e + 11] = i[11], t[e + 12] = i[12], t[e + 13] = i[13], t[e + 14] = i[14], t[e + 15] = i[15], t;
  }
}
const Jt = /* @__PURE__ */ new S(), ht = /* @__PURE__ */ new H(), js = /* @__PURE__ */ new S(0, 0, 0), Ks = /* @__PURE__ */ new S(1, 1, 1), Pt = /* @__PURE__ */ new S(), Re = /* @__PURE__ */ new S(), et = /* @__PURE__ */ new S(), fs = /* @__PURE__ */ new H(), ds = /* @__PURE__ */ new Ie();
class li {
  /**
   * Constructs a new euler instance.
   *
   * @param {number} [x=0] - The angle of the x axis in radians.
   * @param {number} [y=0] - The angle of the y axis in radians.
   * @param {number} [z=0] - The angle of the z axis in radians.
   * @param {string} [order=Euler.DEFAULT_ORDER] - A string representing the order that the rotations are applied.
   */
  constructor(t = 0, e = 0, i = 0, s = li.DEFAULT_ORDER) {
    this.isEuler = !0, this._x = t, this._y = e, this._z = i, this._order = s;
  }
  /**
   * The angle of the x axis in radians.
   *
   * @type {number}
   * @default 0
   */
  get x() {
    return this._x;
  }
  set x(t) {
    this._x = t, this._onChangeCallback();
  }
  /**
   * The angle of the y axis in radians.
   *
   * @type {number}
   * @default 0
   */
  get y() {
    return this._y;
  }
  set y(t) {
    this._y = t, this._onChangeCallback();
  }
  /**
   * The angle of the z axis in radians.
   *
   * @type {number}
   * @default 0
   */
  get z() {
    return this._z;
  }
  set z(t) {
    this._z = t, this._onChangeCallback();
  }
  /**
   * A string representing the order that the rotations are applied.
   *
   * @type {string}
   * @default 'XYZ'
   */
  get order() {
    return this._order;
  }
  set order(t) {
    this._order = t, this._onChangeCallback();
  }
  /**
   * Sets the Euler components.
   *
   * @param {number} x - The angle of the x axis in radians.
   * @param {number} y - The angle of the y axis in radians.
   * @param {number} z - The angle of the z axis in radians.
   * @param {string} [order] - A string representing the order that the rotations are applied.
   * @return {Euler} A reference to this Euler instance.
   */
  set(t, e, i, s = this._order) {
    return this._x = t, this._y = e, this._z = i, this._order = s, this._onChangeCallback(), this;
  }
  /**
   * Returns a new Euler instance with copied values from this instance.
   *
   * @return {Euler} A clone of this instance.
   */
  clone() {
    return new this.constructor(this._x, this._y, this._z, this._order);
  }
  /**
   * Copies the values of the given Euler instance to this instance.
   *
   * @param {Euler} euler - The Euler instance to copy.
   * @return {Euler} A reference to this Euler instance.
   */
  copy(t) {
    return this._x = t._x, this._y = t._y, this._z = t._z, this._order = t._order, this._onChangeCallback(), this;
  }
  /**
   * Sets the angles of this Euler instance from a pure rotation matrix.
   *
   * @param {Matrix4} m - A 4x4 matrix of which the upper 3x3 of matrix is a pure rotation matrix (i.e. unscaled).
   * @param {string} [order] - A string representing the order that the rotations are applied.
   * @param {boolean} [update=true] - Whether the internal `onChange` callback should be executed or not.
   * @return {Euler} A reference to this Euler instance.
   */
  setFromRotationMatrix(t, e = this._order, i = !0) {
    const s = t.elements, n = s[0], r = s[4], a = s[8], o = s[1], c = s[5], h = s[9], l = s[2], u = s[6], d = s[10];
    switch (e) {
      case "XYZ":
        this._y = Math.asin(k(a, -1, 1)), Math.abs(a) < 0.9999999 ? (this._x = Math.atan2(-h, d), this._z = Math.atan2(-r, n)) : (this._x = Math.atan2(u, c), this._z = 0);
        break;
      case "YXZ":
        this._x = Math.asin(-k(h, -1, 1)), Math.abs(h) < 0.9999999 ? (this._y = Math.atan2(a, d), this._z = Math.atan2(o, c)) : (this._y = Math.atan2(-l, n), this._z = 0);
        break;
      case "ZXY":
        this._x = Math.asin(k(u, -1, 1)), Math.abs(u) < 0.9999999 ? (this._y = Math.atan2(-l, d), this._z = Math.atan2(-r, c)) : (this._y = 0, this._z = Math.atan2(o, n));
        break;
      case "ZYX":
        this._y = Math.asin(-k(l, -1, 1)), Math.abs(l) < 0.9999999 ? (this._x = Math.atan2(u, d), this._z = Math.atan2(o, n)) : (this._x = 0, this._z = Math.atan2(-r, c));
        break;
      case "YZX":
        this._z = Math.asin(k(o, -1, 1)), Math.abs(o) < 0.9999999 ? (this._x = Math.atan2(-h, c), this._y = Math.atan2(-l, n)) : (this._x = 0, this._y = Math.atan2(a, d));
        break;
      case "XZY":
        this._z = Math.asin(-k(r, -1, 1)), Math.abs(r) < 0.9999999 ? (this._x = Math.atan2(u, c), this._y = Math.atan2(a, n)) : (this._x = Math.atan2(-h, d), this._y = 0);
        break;
      default:
        pt("Euler: .setFromRotationMatrix() encountered an unknown order: " + e);
    }
    return this._order = e, i === !0 && this._onChangeCallback(), this;
  }
  /**
   * Sets the angles of this Euler instance from a normalized quaternion.
   *
   * @param {Quaternion} q - A normalized Quaternion.
   * @param {string} [order] - A string representing the order that the rotations are applied.
   * @param {boolean} [update=true] - Whether the internal `onChange` callback should be executed or not.
   * @return {Euler} A reference to this Euler instance.
   */
  setFromQuaternion(t, e, i) {
    return fs.makeRotationFromQuaternion(t), this.setFromRotationMatrix(fs, e, i);
  }
  /**
   * Sets the angles of this Euler instance from the given vector.
   *
   * @param {Vector3} v - The vector.
   * @param {string} [order] - A string representing the order that the rotations are applied.
   * @return {Euler} A reference to this Euler instance.
   */
  setFromVector3(t, e = this._order) {
    return this.set(t.x, t.y, t.z, e);
  }
  /**
   * Resets the euler angle with a new order by creating a quaternion from this
   * euler angle and then setting this euler angle with the quaternion and the
   * new order.
   *
   * Warning: This discards revolution information.
   *
   * @param {string} [newOrder] - A string representing the new order that the rotations are applied.
   * @return {Euler} A reference to this Euler instance.
   */
  reorder(t) {
    return ds.setFromEuler(this), this.setFromQuaternion(ds, t);
  }
  /**
   * Returns `true` if this Euler instance is equal with the given one.
   *
   * @param {Euler} euler - The Euler instance to test for equality.
   * @return {boolean} Whether this Euler instance is equal with the given one.
   */
  equals(t) {
    return t._x === this._x && t._y === this._y && t._z === this._z && t._order === this._order;
  }
  /**
   * Sets this Euler instance's components to values from the given array. The first three
   * entries of the array are assign to the x,y and z components. An optional fourth entry
   * defines the Euler order.
   *
   * @param {Array<number,number,number,?string>} array - An array holding the Euler component values.
   * @return {Euler} A reference to this Euler instance.
   */
  fromArray(t) {
    return this._x = t[0], this._y = t[1], this._z = t[2], t[3] !== void 0 && (this._order = t[3]), this._onChangeCallback(), this;
  }
  /**
   * Writes the components of this Euler instance to the given array. If no array is provided,
   * the method returns a new instance.
   *
   * @param {Array<number,number,number,string>} [array=[]] - The target array holding the Euler components.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Array<number,number,number,string>} The Euler components.
   */
  toArray(t = [], e = 0) {
    return t[e] = this._x, t[e + 1] = this._y, t[e + 2] = this._z, t[e + 3] = this._order, t;
  }
  _onChange(t) {
    return this._onChangeCallback = t, this;
  }
  _onChangeCallback() {
  }
  *[Symbol.iterator]() {
    yield this._x, yield this._y, yield this._z, yield this._order;
  }
}
li.DEFAULT_ORDER = "XYZ";
class tn {
  /**
   * Constructs a new layers instance, with membership
   * initially set to layer `0`.
   */
  constructor() {
    this.mask = 1;
  }
  /**
   * Sets membership to the given layer, and remove membership all other layers.
   *
   * @param {number} layer - The layer to set.
   */
  set(t) {
    this.mask = (1 << t | 0) >>> 0;
  }
  /**
   * Adds membership of the given layer.
   *
   * @param {number} layer - The layer to enable.
   */
  enable(t) {
    this.mask |= 1 << t | 0;
  }
  /**
   * Adds membership to all layers.
   */
  enableAll() {
    this.mask = -1;
  }
  /**
   * Toggles the membership of the given layer.
   *
   * @param {number} layer - The layer to toggle.
   */
  toggle(t) {
    this.mask ^= 1 << t | 0;
  }
  /**
   * Removes membership of the given layer.
   *
   * @param {number} layer - The layer to enable.
   */
  disable(t) {
    this.mask &= ~(1 << t | 0);
  }
  /**
   * Removes the membership from all layers.
   */
  disableAll() {
    this.mask = 0;
  }
  /**
   * Returns `true` if this and the given layers object have at least one
   * layer in common.
   *
   * @param {Layers} layers - The layers to test.
   * @return {boolean } Whether this and the given layers object have at least one layer in common or not.
   */
  test(t) {
    return (this.mask & t.mask) !== 0;
  }
  /**
   * Returns `true` if the given layer is enabled.
   *
   * @param {number} layer - The layer to test.
   * @return {boolean } Whether the given layer is enabled or not.
   */
  isEnabled(t) {
    return (this.mask & (1 << t | 0)) !== 0;
  }
}
let en = 0;
const ys = /* @__PURE__ */ new S(), Gt = /* @__PURE__ */ new Ie(), gt = /* @__PURE__ */ new H(), Ue = /* @__PURE__ */ new S(), ge = /* @__PURE__ */ new S(), sn = /* @__PURE__ */ new S(), nn = /* @__PURE__ */ new Ie(), ms = /* @__PURE__ */ new S(1, 0, 0), ps = /* @__PURE__ */ new S(0, 1, 0), xs = /* @__PURE__ */ new S(0, 0, 1), gs = { type: "added" }, rn = { type: "removed" }, Qt = { type: "childadded", child: null }, bi = { type: "childremoved", child: null };
class kt extends ci {
  /**
   * Constructs a new 3D object.
   */
  constructor() {
    super(), this.isObject3D = !0, Object.defineProperty(this, "id", { value: en++ }), this.uuid = hi(), this.name = "", this.type = "Object3D", this.parent = null, this.children = [], this.up = kt.DEFAULT_UP.clone();
    const t = new S(), e = new li(), i = new Ie(), s = new S(1, 1, 1);
    function n() {
      i.setFromEuler(e, !1);
    }
    function r() {
      e.setFromQuaternion(i, void 0, !1);
    }
    e._onChange(n), i._onChange(r), Object.defineProperties(this, {
      /**
       * Represents the object's local position.
       *
       * @name Object3D#position
       * @type {Vector3}
       * @default (0,0,0)
       */
      position: {
        configurable: !0,
        enumerable: !0,
        value: t
      },
      /**
       * Represents the object's local rotation as Euler angles, in radians.
       *
       * @name Object3D#rotation
       * @type {Euler}
       * @default (0,0,0)
       */
      rotation: {
        configurable: !0,
        enumerable: !0,
        value: e
      },
      /**
       * Represents the object's local rotation as Quaternions.
       *
       * @name Object3D#quaternion
       * @type {Quaternion}
       */
      quaternion: {
        configurable: !0,
        enumerable: !0,
        value: i
      },
      /**
       * Represents the object's local scale.
       *
       * @name Object3D#scale
       * @type {Vector3}
       * @default (1,1,1)
       */
      scale: {
        configurable: !0,
        enumerable: !0,
        value: s
      },
      /**
       * Represents the object's model-view matrix.
       *
       * @name Object3D#modelViewMatrix
       * @type {Matrix4}
       */
      modelViewMatrix: {
        value: new H()
      },
      /**
       * Represents the object's normal matrix.
       *
       * @name Object3D#normalMatrix
       * @type {Matrix3}
       */
      normalMatrix: {
        value: new Tt()
      }
    }), this.matrix = new H(), this.matrixWorld = new H(), this.matrixAutoUpdate = kt.DEFAULT_MATRIX_AUTO_UPDATE, this.matrixWorldAutoUpdate = kt.DEFAULT_MATRIX_WORLD_AUTO_UPDATE, this.matrixWorldNeedsUpdate = !1, this.layers = new tn(), this.visible = !0, this.castShadow = !1, this.receiveShadow = !1, this.frustumCulled = !0, this.renderOrder = 0, this.animations = [], this.customDepthMaterial = void 0, this.customDistanceMaterial = void 0, this.static = !1, this.userData = {}, this.pivot = null;
  }
  /**
   * A callback that is executed immediately before a 3D object is rendered to a shadow map.
   *
   * @param {Renderer|WebGLRenderer} renderer - The renderer.
   * @param {Object3D} object - The 3D object.
   * @param {Camera} camera - The camera that is used to render the scene.
   * @param {Camera} shadowCamera - The shadow camera.
   * @param {BufferGeometry} geometry - The 3D object's geometry.
   * @param {Material} depthMaterial - The depth material.
   * @param {Object} group - The geometry group data.
   */
  onBeforeShadow() {
  }
  /**
   * A callback that is executed immediately after a 3D object is rendered to a shadow map.
   *
   * @param {Renderer|WebGLRenderer} renderer - The renderer.
   * @param {Object3D} object - The 3D object.
   * @param {Camera} camera - The camera that is used to render the scene.
   * @param {Camera} shadowCamera - The shadow camera.
   * @param {BufferGeometry} geometry - The 3D object's geometry.
   * @param {Material} depthMaterial - The depth material.
   * @param {Object} group - The geometry group data.
   */
  onAfterShadow() {
  }
  /**
   * A callback that is executed immediately before a 3D object is rendered.
   *
   * @param {Renderer|WebGLRenderer} renderer - The renderer.
   * @param {Object3D} object - The 3D object.
   * @param {Camera} camera - The camera that is used to render the scene.
   * @param {BufferGeometry} geometry - The 3D object's geometry.
   * @param {Material} material - The 3D object's material.
   * @param {Object} group - The geometry group data.
   */
  onBeforeRender() {
  }
  /**
   * A callback that is executed immediately after a 3D object is rendered.
   *
   * @param {Renderer|WebGLRenderer} renderer - The renderer.
   * @param {Object3D} object - The 3D object.
   * @param {Camera} camera - The camera that is used to render the scene.
   * @param {BufferGeometry} geometry - The 3D object's geometry.
   * @param {Material} material - The 3D object's material.
   * @param {Object} group - The geometry group data.
   */
  onAfterRender() {
  }
  /**
   * Applies the given transformation matrix to the object and updates the object's position,
   * rotation and scale.
   *
   * @param {Matrix4} matrix - The transformation matrix.
   */
  applyMatrix4(t) {
    this.matrixAutoUpdate && this.updateMatrix(), this.matrix.premultiply(t), this.matrix.decompose(this.position, this.quaternion, this.scale);
  }
  /**
   * Applies a rotation represented by given the quaternion to the 3D object.
   *
   * @param {Quaternion} q - The quaternion.
   * @return {Object3D} A reference to this instance.
   */
  applyQuaternion(t) {
    return this.quaternion.premultiply(t), this;
  }
  /**
   * Sets the given rotation represented as an axis/angle couple to the 3D object.
   *
   * @param {Vector3} axis - The (normalized) axis vector.
   * @param {number} angle - The angle in radians.
   */
  setRotationFromAxisAngle(t, e) {
    this.quaternion.setFromAxisAngle(t, e);
  }
  /**
   * Sets the given rotation represented as Euler angles to the 3D object.
   *
   * @param {Euler} euler - The Euler angles.
   */
  setRotationFromEuler(t) {
    this.quaternion.setFromEuler(t, !0);
  }
  /**
   * Sets the given rotation represented as rotation matrix to the 3D object.
   *
   * @param {Matrix4} m - Although a 4x4 matrix is expected, the upper 3x3 portion must be
   * a pure rotation matrix (i.e, unscaled).
   */
  setRotationFromMatrix(t) {
    this.quaternion.setFromRotationMatrix(t);
  }
  /**
   * Sets the given rotation represented as a Quaternion to the 3D object.
   *
   * @param {Quaternion} q - The Quaternion
   */
  setRotationFromQuaternion(t) {
    this.quaternion.copy(t);
  }
  /**
   * Rotates the 3D object along an axis in local space.
   *
   * @param {Vector3} axis - The (normalized) axis vector.
   * @param {number} angle - The angle in radians.
   * @return {Object3D} A reference to this instance.
   */
  rotateOnAxis(t, e) {
    return Gt.setFromAxisAngle(t, e), this.quaternion.multiply(Gt), this;
  }
  /**
   * Rotates the 3D object along an axis in world space.
   *
   * @param {Vector3} axis - The (normalized) axis vector.
   * @param {number} angle - The angle in radians.
   * @return {Object3D} A reference to this instance.
   */
  rotateOnWorldAxis(t, e) {
    return Gt.setFromAxisAngle(t, e), this.quaternion.premultiply(Gt), this;
  }
  /**
   * Rotates the 3D object around its X axis in local space.
   *
   * @param {number} angle - The angle in radians.
   * @return {Object3D} A reference to this instance.
   */
  rotateX(t) {
    return this.rotateOnAxis(ms, t);
  }
  /**
   * Rotates the 3D object around its Y axis in local space.
   *
   * @param {number} angle - The angle in radians.
   * @return {Object3D} A reference to this instance.
   */
  rotateY(t) {
    return this.rotateOnAxis(ps, t);
  }
  /**
   * Rotates the 3D object around its Z axis in local space.
   *
   * @param {number} angle - The angle in radians.
   * @return {Object3D} A reference to this instance.
   */
  rotateZ(t) {
    return this.rotateOnAxis(xs, t);
  }
  /**
   * Translate the 3D object by a distance along the given axis in local space.
   *
   * @param {Vector3} axis - The (normalized) axis vector.
   * @param {number} distance - The distance in world units.
   * @return {Object3D} A reference to this instance.
   */
  translateOnAxis(t, e) {
    return ys.copy(t).applyQuaternion(this.quaternion), this.position.add(ys.multiplyScalar(e)), this;
  }
  /**
   * Translate the 3D object by a distance along its X-axis in local space.
   *
   * @param {number} distance - The distance in world units.
   * @return {Object3D} A reference to this instance.
   */
  translateX(t) {
    return this.translateOnAxis(ms, t);
  }
  /**
   * Translate the 3D object by a distance along its Y-axis in local space.
   *
   * @param {number} distance - The distance in world units.
   * @return {Object3D} A reference to this instance.
   */
  translateY(t) {
    return this.translateOnAxis(ps, t);
  }
  /**
   * Translate the 3D object by a distance along its Z-axis in local space.
   *
   * @param {number} distance - The distance in world units.
   * @return {Object3D} A reference to this instance.
   */
  translateZ(t) {
    return this.translateOnAxis(xs, t);
  }
  /**
   * Converts the given vector from this 3D object's local space to world space.
   *
   * @param {Vector3} vector - The vector to convert.
   * @return {Vector3} The converted vector.
   */
  localToWorld(t) {
    return this.updateWorldMatrix(!0, !1), t.applyMatrix4(this.matrixWorld);
  }
  /**
   * Converts the given vector from this 3D object's world space to local space.
   *
   * @param {Vector3} vector - The vector to convert.
   * @return {Vector3} The converted vector.
   */
  worldToLocal(t) {
    return this.updateWorldMatrix(!0, !1), t.applyMatrix4(gt.copy(this.matrixWorld).invert());
  }
  /**
   * Rotates the object to face a point in world space.
   *
   * This method does not support objects having non-uniformly-scaled parent(s).
   *
   * @param {number|Vector3} x - The x coordinate in world space. Alternatively, a vector representing a position in world space
   * @param {number} [y] - The y coordinate in world space.
   * @param {number} [z] - The z coordinate in world space.
   */
  lookAt(t, e, i) {
    t.isVector3 ? Ue.copy(t) : Ue.set(t, e, i);
    const s = this.parent;
    this.updateWorldMatrix(!0, !1), ge.setFromMatrixPosition(this.matrixWorld), this.isCamera || this.isLight ? gt.lookAt(ge, Ue, this.up) : gt.lookAt(Ue, ge, this.up), this.quaternion.setFromRotationMatrix(gt), s && (gt.extractRotation(s.matrixWorld), Gt.setFromRotationMatrix(gt), this.quaternion.premultiply(Gt.invert()));
  }
  /**
   * Adds the given 3D object as a child to this 3D object. An arbitrary number of
   * objects may be added. Any current parent on an object passed in here will be
   * removed, since an object can have at most one parent.
   *
   * @fires Object3D#added
   * @fires Object3D#childadded
   * @param {Object3D} object - The 3D object to add.
   * @return {Object3D} A reference to this instance.
   */
  add(t) {
    if (arguments.length > 1) {
      for (let e = 0; e < arguments.length; e++)
        this.add(arguments[e]);
      return this;
    }
    return t === this ? (Yt("Object3D.add: object can't be added as a child of itself.", t), this) : (t && t.isObject3D ? (t.removeFromParent(), t.parent = this, this.children.push(t), t.dispatchEvent(gs), Qt.child = t, this.dispatchEvent(Qt), Qt.child = null) : Yt("Object3D.add: object not an instance of THREE.Object3D.", t), this);
  }
  /**
   * Removes the given 3D object as child from this 3D object.
   * An arbitrary number of objects may be removed.
   *
   * @fires Object3D#removed
   * @fires Object3D#childremoved
   * @param {Object3D} object - The 3D object to remove.
   * @return {Object3D} A reference to this instance.
   */
  remove(t) {
    if (arguments.length > 1) {
      for (let i = 0; i < arguments.length; i++)
        this.remove(arguments[i]);
      return this;
    }
    const e = this.children.indexOf(t);
    return e !== -1 && (t.parent = null, this.children.splice(e, 1), t.dispatchEvent(rn), bi.child = t, this.dispatchEvent(bi), bi.child = null), this;
  }
  /**
   * Removes this 3D object from its current parent.
   *
   * @fires Object3D#removed
   * @fires Object3D#childremoved
   * @return {Object3D} A reference to this instance.
   */
  removeFromParent() {
    const t = this.parent;
    return t !== null && t.remove(this), this;
  }
  /**
   * Removes all child objects.
   *
   * @fires Object3D#removed
   * @fires Object3D#childremoved
   * @return {Object3D} A reference to this instance.
   */
  clear() {
    return this.remove(...this.children);
  }
  /**
   * Adds the given 3D object as a child of this 3D object, while maintaining the object's world
   * transform. This method does not support scene graphs having non-uniformly-scaled nodes(s).
   *
   * @fires Object3D#added
   * @fires Object3D#childadded
   * @param {Object3D} object - The 3D object to attach.
   * @return {Object3D} A reference to this instance.
   */
  attach(t) {
    return this.updateWorldMatrix(!0, !1), gt.copy(this.matrixWorld).invert(), t.parent !== null && (t.parent.updateWorldMatrix(!0, !1), gt.multiply(t.parent.matrixWorld)), t.applyMatrix4(gt), t.removeFromParent(), t.parent = this, this.children.push(t), t.updateWorldMatrix(!1, !0), t.dispatchEvent(gs), Qt.child = t, this.dispatchEvent(Qt), Qt.child = null, this;
  }
  /**
   * Searches through the 3D object and its children, starting with the 3D object
   * itself, and returns the first with a matching ID.
   *
   * @param {number} id - The id.
   * @return {Object3D|undefined} The found 3D object. Returns `undefined` if no 3D object has been found.
   */
  getObjectById(t) {
    return this.getObjectByProperty("id", t);
  }
  /**
   * Searches through the 3D object and its children, starting with the 3D object
   * itself, and returns the first with a matching name.
   *
   * @param {string} name - The name.
   * @return {Object3D|undefined} The found 3D object. Returns `undefined` if no 3D object has been found.
   */
  getObjectByName(t) {
    return this.getObjectByProperty("name", t);
  }
  /**
   * Searches through the 3D object and its children, starting with the 3D object
   * itself, and returns the first with a matching property value.
   *
   * @param {string} name - The name of the property.
   * @param {any} value - The value.
   * @return {Object3D|undefined} The found 3D object. Returns `undefined` if no 3D object has been found.
   */
  getObjectByProperty(t, e) {
    if (this[t] === e) return this;
    for (let i = 0, s = this.children.length; i < s; i++) {
      const r = this.children[i].getObjectByProperty(t, e);
      if (r !== void 0)
        return r;
    }
  }
  /**
   * Searches through the 3D object and its children, starting with the 3D object
   * itself, and returns all 3D objects with a matching property value.
   *
   * @param {string} name - The name of the property.
   * @param {any} value - The value.
   * @param {Array<Object3D>} result - The method stores the result in this array.
   * @return {Array<Object3D>} The found 3D objects.
   */
  getObjectsByProperty(t, e, i = []) {
    this[t] === e && i.push(this);
    const s = this.children;
    for (let n = 0, r = s.length; n < r; n++)
      s[n].getObjectsByProperty(t, e, i);
    return i;
  }
  /**
   * Returns a vector representing the position of the 3D object in world space.
   *
   * @param {Vector3} target - The target vector the result is stored to.
   * @return {Vector3} The 3D object's position in world space.
   */
  getWorldPosition(t) {
    return this.updateWorldMatrix(!0, !1), t.setFromMatrixPosition(this.matrixWorld);
  }
  /**
   * Returns a Quaternion representing the position of the 3D object in world space.
   *
   * @param {Quaternion} target - The target Quaternion the result is stored to.
   * @return {Quaternion} The 3D object's rotation in world space.
   */
  getWorldQuaternion(t) {
    return this.updateWorldMatrix(!0, !1), this.matrixWorld.decompose(ge, t, sn), t;
  }
  /**
   * Returns a vector representing the scale of the 3D object in world space.
   *
   * @param {Vector3} target - The target vector the result is stored to.
   * @return {Vector3} The 3D object's scale in world space.
   */
  getWorldScale(t) {
    return this.updateWorldMatrix(!0, !1), this.matrixWorld.decompose(ge, nn, t), t;
  }
  /**
   * Returns a vector representing the ("look") direction of the 3D object in world space.
   *
   * @param {Vector3} target - The target vector the result is stored to.
   * @return {Vector3} The 3D object's direction in world space.
   */
  getWorldDirection(t) {
    this.updateWorldMatrix(!0, !1);
    const e = this.matrixWorld.elements;
    return t.set(e[8], e[9], e[10]).normalize();
  }
  /**
   * Abstract method to get intersections between a casted ray and this
   * 3D object. Renderable 3D objects such as {@link Mesh}, {@link Line} or {@link Points}
   * implement this method in order to use raycasting.
   *
   * @abstract
   * @param {Raycaster} raycaster - The raycaster.
   * @param {Array<Object>} intersects - An array holding the result of the method.
   */
  raycast() {
  }
  /**
   * Abstract method to test whether this 3D object intersects the given frustum.
   * Renderable 3D objects such as {@link Mesh}, {@link Line} or {@link Points}
   * implement this method in order to use frustum culling.
   *
   * @abstract
   * @param {Frustum|FrustumArray} frustum - The frustum to test.
   * @return {boolean|undefined} Whether this 3D object intersects the given frustum or not.
   */
  intersectsFrustum() {
  }
  /**
   * Executes the callback on this 3D object and all descendants.
   *
   * Note: Modifying the scene graph inside the callback is discouraged.
   *
   * @param {Function} callback - A callback function that allows to process the current 3D object.
   */
  traverse(t) {
    t(this);
    const e = this.children;
    for (let i = 0, s = e.length; i < s; i++)
      e[i].traverse(t);
  }
  /**
   * Like {@link Object3D#traverse}, but the callback will only be executed for visible 3D objects.
   * Descendants of invisible 3D objects are not traversed.
   *
   * Note: Modifying the scene graph inside the callback is discouraged.
   *
   * @param {Function} callback - A callback function that allows to process the current 3D object.
   */
  traverseVisible(t) {
    if (this.visible === !1) return;
    t(this);
    const e = this.children;
    for (let i = 0, s = e.length; i < s; i++)
      e[i].traverseVisible(t);
  }
  /**
   * Like {@link Object3D#traverse}, but the callback will only be executed for all ancestors.
   *
   * Note: Modifying the scene graph inside the callback is discouraged.
   *
   * @param {Function} callback - A callback function that allows to process the current 3D object.
   */
  traverseAncestors(t) {
    const e = this.parent;
    e !== null && (t(e), e.traverseAncestors(t));
  }
  /**
   * Updates the transformation matrix in local space by computing it from the current
   * position, rotation and scale values.
   */
  updateMatrix() {
    this.matrix.compose(this.position, this.quaternion, this.scale);
    const t = this.pivot;
    if (t !== null) {
      const e = t.x, i = t.y, s = t.z, n = this.matrix.elements;
      n[12] += e - n[0] * e - n[4] * i - n[8] * s, n[13] += i - n[1] * e - n[5] * i - n[9] * s, n[14] += s - n[2] * e - n[6] * i - n[10] * s;
    }
    this.matrixWorldNeedsUpdate = !0;
  }
  /**
   * Updates the transformation matrix in world space of this 3D objects and its descendants.
   *
   * To ensure correct results, this method also recomputes the 3D object's transformation matrix in
   * local space. The computation of the local and world matrix can be controlled with the
   * {@link Object3D#matrixAutoUpdate} and {@link Object3D#matrixWorldAutoUpdate} flags which are both
   * `true` by default.  Set these flags to `false` if you need more control over the update matrix process.
   *
   * @param {boolean} [force=false] - When set to `true`, a recomputation of world matrices is forced even
   * when {@link Object3D#matrixWorldNeedsUpdate} is `false`.
   */
  updateMatrixWorld(t) {
    this.matrixAutoUpdate && this.updateMatrix(), (this.matrixWorldNeedsUpdate || t) && (this.matrixWorldAutoUpdate === !0 && (this.parent === null ? this.matrixWorld.copy(this.matrix) : this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix)), this.matrixWorldNeedsUpdate = !1, t = !0);
    const e = this.children;
    for (let i = 0, s = e.length; i < s; i++)
      e[i].updateMatrixWorld(t);
  }
  /**
   * An alternative version of {@link Object3D#updateMatrixWorld} with more control over the
   * update of ancestor and descendant nodes.
   *
   * @param {boolean} [updateParents=false] Whether ancestor nodes should be updated or not.
   * @param {boolean} [updateChildren=false] Whether descendant nodes should be updated or not.
   * @param {boolean} [force=false] - When set to `true`, a recomputation of world matrices is forced even
   * when {@link Object3D#matrixWorldNeedsUpdate} is `false`.
   */
  updateWorldMatrix(t, e, i = !1) {
    const s = this.parent;
    if (t === !0 && s !== null && s.updateWorldMatrix(!0, !1), this.matrixAutoUpdate && this.updateMatrix(), (this.matrixWorldNeedsUpdate || i) && (this.matrixWorldAutoUpdate === !0 && (this.parent === null ? this.matrixWorld.copy(this.matrix) : this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix)), this.matrixWorldNeedsUpdate = !1, i = !0), e === !0) {
      const n = this.children;
      for (let r = 0, a = n.length; r < a; r++)
        n[r].updateWorldMatrix(!1, !0, i);
    }
  }
  /**
   * Serializes the 3D object into JSON.
   *
   * @param {?(Object|string)} meta - An optional value holding meta information about the serialization.
   * @return {Object} A JSON object representing the serialized 3D object.
   * @see {@link ObjectLoader#parse}
   */
  toJSON(t) {
    const e = t === void 0 || typeof t == "string", i = {};
    e && (t = {
      geometries: {},
      materials: {},
      textures: {},
      images: {},
      shapes: {},
      skeletons: {},
      animations: {},
      nodes: {}
    }, i.metadata = {
      version: 4.7,
      type: "Object",
      generator: "Object3D.toJSON"
    });
    const s = {};
    s.uuid = this.uuid, s.type = this.type, s.name = this.name, s.castShadow = this.castShadow, s.receiveShadow = this.receiveShadow, s.visible = this.visible, s.frustumCulled = this.frustumCulled, s.renderOrder = this.renderOrder, s.static = this.static, s.matrixAutoUpdate = this.matrixAutoUpdate, Object.keys(this.userData).length > 0 && (s.userData = this.userData), s.layers = this.layers.mask, s.matrix = this.matrix.toArray(), s.up = this.up.toArray(), this.pivot !== null && (s.pivot = this.pivot.toArray()), this.morphTargetDictionary !== void 0 && (s.morphTargetDictionary = Object.assign({}, this.morphTargetDictionary)), this.morphTargetInfluences !== void 0 && (s.morphTargetInfluences = this.morphTargetInfluences.slice()), this.isInstancedMesh && (s.type = "InstancedMesh", s.count = this.count, s.instanceMatrix = this.instanceMatrix.toJSON(), this.instanceColor !== null && (s.instanceColor = this.instanceColor.toJSON())), this.isBatchedMesh && (s.type = "BatchedMesh", s.perObjectFrustumCulled = this.perObjectFrustumCulled, s.sortObjects = this.sortObjects, s.drawRanges = this._drawRanges, s.reservedRanges = this._reservedRanges, s.geometryInfo = this._geometryInfo.map((a) => ({
      ...a,
      boundingBox: a.boundingBox ? a.boundingBox.toJSON() : void 0,
      boundingSphere: a.boundingSphere ? a.boundingSphere.toJSON() : void 0
    })), s.instanceInfo = this._instanceInfo.map((a) => ({ ...a })), s.availableInstanceIds = this._availableInstanceIds.slice(), s.availableGeometryIds = this._availableGeometryIds.slice(), s.nextIndexStart = this._nextIndexStart, s.nextVertexStart = this._nextVertexStart, s.geometryCount = this._geometryCount, s.maxInstanceCount = this._maxInstanceCount, s.maxVertexCount = this._maxVertexCount, s.maxIndexCount = this._maxIndexCount, s.geometryInitialized = this._geometryInitialized, s.matricesTexture = this._matricesTexture.toJSON(t), s.indirectTexture = this._indirectTexture.toJSON(t), this._colorsTexture !== null && (s.colorsTexture = this._colorsTexture.toJSON(t)), this.boundingSphere !== null && (s.boundingSphere = this.boundingSphere.toJSON()), this.boundingBox !== null && (s.boundingBox = this.boundingBox.toJSON()));
    function n(a, o) {
      return a[o.uuid] === void 0 && (a[o.uuid] = o.toJSON(t)), o.uuid;
    }
    if (this.isScene)
      this.background && (this.background.isColor ? s.background = this.background.toJSON() : this.background.isTexture && (s.background = this.background.toJSON(t).uuid)), this.environment && this.environment.isTexture && this.environment.isRenderTargetTexture !== !0 && (s.environment = this.environment.toJSON(t).uuid);
    else if (this.isMesh || this.isLine || this.isPoints) {
      s.geometry = n(t.geometries, this.geometry);
      const a = this.geometry.parameters;
      if (a !== void 0 && a.shapes !== void 0) {
        const o = a.shapes;
        if (Array.isArray(o))
          for (let c = 0, h = o.length; c < h; c++) {
            const l = o[c];
            n(t.shapes, l);
          }
        else
          n(t.shapes, o);
      }
    }
    if (this.isSkinnedMesh && (s.bindMode = this.bindMode, s.bindMatrix = this.bindMatrix.toArray(), this.skeleton !== void 0 && (n(t.skeletons, this.skeleton), s.skeleton = this.skeleton.uuid)), this.material !== void 0)
      if (Array.isArray(this.material)) {
        const a = [];
        for (let o = 0, c = this.material.length; o < c; o++)
          a.push(n(t.materials, this.material[o]));
        s.material = a;
      } else
        s.material = n(t.materials, this.material);
    if (this.children.length > 0) {
      s.children = [];
      for (let a = 0; a < this.children.length; a++)
        s.children.push(this.children[a].toJSON(t).object);
    }
    if (this.animations.length > 0) {
      s.animations = [];
      for (let a = 0; a < this.animations.length; a++) {
        const o = this.animations[a];
        s.animations.push(n(t.animations, o));
      }
    }
    if (e) {
      const a = r(t.geometries), o = r(t.materials), c = r(t.textures), h = r(t.images), l = r(t.shapes), u = r(t.skeletons), d = r(t.animations), y = r(t.nodes);
      a.length > 0 && (i.geometries = a), o.length > 0 && (i.materials = o), c.length > 0 && (i.textures = c), h.length > 0 && (i.images = h), l.length > 0 && (i.shapes = l), u.length > 0 && (i.skeletons = u), d.length > 0 && (i.animations = d), y.length > 0 && (i.nodes = y);
    }
    return i.object = s, i;
    function r(a) {
      const o = [];
      for (const c in a) {
        const h = a[c];
        delete h.metadata, o.push(h);
      }
      return o;
    }
  }
  /**
   * Returns a new 3D object with copied values from this instance.
   *
   * @param {boolean} [recursive=true] - When set to `true`, descendants of the 3D object are also cloned.
   * @return {Object3D} A clone of this instance.
   */
  clone(t) {
    return new this.constructor().copy(this, t);
  }
  /**
   * Copies the values of the given 3D object to this instance.
   *
   * @param {Object3D} source - The 3D object to copy.
   * @param {boolean} [recursive=true] - When set to `true`, descendants of the 3D object are cloned.
   * @return {Object3D} A reference to this instance.
   */
  copy(t, e = !0) {
    if (this.name = t.name, this.up.copy(t.up), this.position.copy(t.position), this.rotation.order = t.rotation.order, this.quaternion.copy(t.quaternion), this.scale.copy(t.scale), this.pivot = t.pivot !== null ? t.pivot.clone() : null, this.matrix.copy(t.matrix), this.matrixWorld.copy(t.matrixWorld), this.matrixAutoUpdate = t.matrixAutoUpdate, this.matrixWorldAutoUpdate = t.matrixWorldAutoUpdate, this.matrixWorldNeedsUpdate = t.matrixWorldNeedsUpdate, this.layers.mask = t.layers.mask, this.visible = t.visible, this.castShadow = t.castShadow, this.receiveShadow = t.receiveShadow, this.frustumCulled = t.frustumCulled, this.renderOrder = t.renderOrder, this.static = t.static, this.animations = t.animations.slice(), this.userData = JSON.parse(JSON.stringify(t.userData)), e === !0)
      for (let i = 0; i < t.children.length; i++) {
        const s = t.children[i];
        this.add(s.clone());
      }
    return this;
  }
  /**
   * Frees the GPU-related resources allocated by this instance. Call this
   * method whenever this instance is no longer used in your app.
   *
   * Geometries, materials and textures are potentially shared with other
   * 3D objects and must be disposed of separately.
   *
   * @fires Object3D#dispose
   */
  dispose() {
    this.dispatchEvent({ type: "dispose" });
  }
}
kt.DEFAULT_UP = /* @__PURE__ */ new S(0, 1, 0);
kt.DEFAULT_MATRIX_AUTO_UPDATE = !0;
kt.DEFAULT_MATRIX_WORLD_AUTO_UPDATE = !0;
const lt = /* @__PURE__ */ new S(), wt = /* @__PURE__ */ new S(), zi = /* @__PURE__ */ new S(), bt = /* @__PURE__ */ new S(), jt = /* @__PURE__ */ new S(), Kt = /* @__PURE__ */ new S(), ws = /* @__PURE__ */ new S(), _i = /* @__PURE__ */ new S(), Mi = /* @__PURE__ */ new S(), Ai = /* @__PURE__ */ new S(), Si = /* @__PURE__ */ new Ve(), Bi = /* @__PURE__ */ new Ve(), Ti = /* @__PURE__ */ new Ve();
class ot {
  /**
   * Constructs a new triangle.
   *
   * @param {Vector3} [a=(0,0,0)] - The first corner of the triangle.
   * @param {Vector3} [b=(0,0,0)] - The second corner of the triangle.
   * @param {Vector3} [c=(0,0,0)] - The third corner of the triangle.
   */
  constructor(t = new S(), e = new S(), i = new S()) {
    this.a = t, this.b = e, this.c = i;
  }
  /**
   * Computes the normal vector of a triangle.
   *
   * @param {Vector3} a - The first corner of the triangle.
   * @param {Vector3} b - The second corner of the triangle.
   * @param {Vector3} c - The third corner of the triangle.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The triangle's normal.
   */
  static getNormal(t, e, i, s) {
    s.subVectors(i, e), lt.subVectors(t, e), s.cross(lt);
    const n = s.lengthSq();
    return n > 0 ? s.multiplyScalar(1 / Math.sqrt(n)) : s.set(0, 0, 0);
  }
  /**
   * Computes a barycentric coordinates from the given vector.
   * Returns `null` if the triangle is degenerate.
   *
   * @param {Vector3} point - A point in 3D space.
   * @param {Vector3} a - The first corner of the triangle.
   * @param {Vector3} b - The second corner of the triangle.
   * @param {Vector3} c - The third corner of the triangle.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The barycentric coordinates for the given point
   */
  static getBarycoord(t, e, i, s, n) {
    lt.subVectors(s, e), wt.subVectors(i, e), zi.subVectors(t, e);
    const r = lt.dot(lt), a = lt.dot(wt), o = lt.dot(zi), c = wt.dot(wt), h = wt.dot(zi), l = r * c - a * a;
    if (l === 0)
      return n.set(0, 0, 0), null;
    const u = 1 / l, d = (c * o - a * h) * u, y = (r * h - a * o) * u;
    return n.set(1 - d - y, y, d);
  }
  /**
   * Returns `true` if the given point, when projected onto the plane of the
   * triangle, lies within the triangle.
   *
   * @param {Vector3} point - The point in 3D space to test.
   * @param {Vector3} a - The first corner of the triangle.
   * @param {Vector3} b - The second corner of the triangle.
   * @param {Vector3} c - The third corner of the triangle.
   * @return {boolean} Whether the given point, when projected onto the plane of the
   * triangle, lies within the triangle or not.
   */
  static containsPoint(t, e, i, s) {
    return this.getBarycoord(t, e, i, s, bt) === null ? !1 : bt.x >= 0 && bt.y >= 0 && bt.x + bt.y <= 1;
  }
  /**
   * Computes the value barycentrically interpolated for the given point on the
   * triangle. Returns `null` if the triangle is degenerate.
   *
   * @param {Vector3} point - Position of interpolated point.
   * @param {Vector3} p1 - The first corner of the triangle.
   * @param {Vector3} p2 - The second corner of the triangle.
   * @param {Vector3} p3 - The third corner of the triangle.
   * @param {Vector3} v1 - Value to interpolate of first vertex.
   * @param {Vector3} v2 - Value to interpolate of second vertex.
   * @param {Vector3} v3 - Value to interpolate of third vertex.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The interpolated value.
   */
  static getInterpolation(t, e, i, s, n, r, a, o) {
    return this.getBarycoord(t, e, i, s, bt) === null ? (o.x = 0, o.y = 0, "z" in o && (o.z = 0), "w" in o && (o.w = 0), null) : (o.setScalar(0), o.addScaledVector(n, bt.x), o.addScaledVector(r, bt.y), o.addScaledVector(a, bt.z), o);
  }
  /**
   * Computes the value barycentrically interpolated for the given attribute and indices.
   *
   * @param {BufferAttribute} attr - The attribute to interpolate.
   * @param {number} i1 - Index of first vertex.
   * @param {number} i2 - Index of second vertex.
   * @param {number} i3 - Index of third vertex.
   * @param {Vector3} barycoord - The barycoordinate value to use to interpolate.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The interpolated attribute value.
   */
  static getInterpolatedAttribute(t, e, i, s, n, r) {
    return Si.setScalar(0), Bi.setScalar(0), Ti.setScalar(0), Si.fromBufferAttribute(t, e), Bi.fromBufferAttribute(t, i), Ti.fromBufferAttribute(t, s), r.setScalar(0), r.addScaledVector(Si, n.x), r.addScaledVector(Bi, n.y), r.addScaledVector(Ti, n.z), r;
  }
  /**
   * Returns `true` if the triangle is oriented towards the given direction.
   *
   * @param {Vector3} a - The first corner of the triangle.
   * @param {Vector3} b - The second corner of the triangle.
   * @param {Vector3} c - The third corner of the triangle.
   * @param {Vector3} direction - The (normalized) direction vector.
   * @return {boolean} Whether the triangle is oriented towards the given direction or not.
   */
  static isFrontFacing(t, e, i, s) {
    return lt.subVectors(i, e), wt.subVectors(t, e), lt.cross(wt).dot(s) < 0;
  }
  /**
   * Sets the triangle's vertices by copying the given values.
   *
   * @param {Vector3} a - The first corner of the triangle.
   * @param {Vector3} b - The second corner of the triangle.
   * @param {Vector3} c - The third corner of the triangle.
   * @return {Triangle} A reference to this triangle.
   */
  set(t, e, i) {
    return this.a.copy(t), this.b.copy(e), this.c.copy(i), this;
  }
  /**
   * Sets the triangle's vertices by copying the given array values.
   *
   * @param {Array<Vector3>} points - An array with 3D points.
   * @param {number} i0 - The array index representing the first corner of the triangle.
   * @param {number} i1 - The array index representing the second corner of the triangle.
   * @param {number} i2 - The array index representing the third corner of the triangle.
   * @return {Triangle} A reference to this triangle.
   */
  setFromPointsAndIndices(t, e, i, s) {
    return this.a.copy(t[e]), this.b.copy(t[i]), this.c.copy(t[s]), this;
  }
  /**
   * Sets the triangle's vertices by copying the given attribute values.
   *
   * @param {BufferAttribute} attribute - A buffer attribute with 3D points data.
   * @param {number} i0 - The attribute index representing the first corner of the triangle.
   * @param {number} i1 - The attribute index representing the second corner of the triangle.
   * @param {number} i2 - The attribute index representing the third corner of the triangle.
   * @return {Triangle} A reference to this triangle.
   */
  setFromAttributeAndIndices(t, e, i, s) {
    return this.a.fromBufferAttribute(t, e), this.b.fromBufferAttribute(t, i), this.c.fromBufferAttribute(t, s), this;
  }
  /**
   * Returns a new triangle with copied values from this instance.
   *
   * @return {Triangle} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Copies the values of the given triangle to this instance.
   *
   * @param {Triangle} triangle - The triangle to copy.
   * @return {Triangle} A reference to this triangle.
   */
  copy(t) {
    return this.a.copy(t.a), this.b.copy(t.b), this.c.copy(t.c), this;
  }
  /**
   * Computes the area of the triangle.
   *
   * @return {number} The triangle's area.
   */
  getArea() {
    return lt.subVectors(this.c, this.b), wt.subVectors(this.a, this.b), lt.cross(wt).length() * 0.5;
  }
  /**
   * Computes the midpoint of the triangle.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The triangle's midpoint.
   */
  getMidpoint(t) {
    return t.addVectors(this.a, this.b).add(this.c).multiplyScalar(1 / 3);
  }
  /**
   * Computes the normal of the triangle.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The triangle's normal.
   */
  getNormal(t) {
    return ot.getNormal(this.a, this.b, this.c, t);
  }
  /**
   * Computes a plane the triangle lies within.
   *
   * @param {Plane} target - The target vector that is used to store the method's result.
   * @return {Plane} The plane the triangle lies within.
   */
  getPlane(t) {
    return t.setFromCoplanarPoints(this.a, this.b, this.c);
  }
  /**
   * Computes a barycentric coordinates from the given vector.
   * Returns `null` if the triangle is degenerate.
   *
   * @param {Vector3} point - A point in 3D space.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The barycentric coordinates for the given point
   */
  getBarycoord(t, e) {
    return ot.getBarycoord(t, this.a, this.b, this.c, e);
  }
  /**
   * Computes the value barycentrically interpolated for the given point on the
   * triangle. Returns `null` if the triangle is degenerate.
   *
   * @param {Vector3} point - Position of interpolated point.
   * @param {Vector3} v1 - Value to interpolate of first vertex.
   * @param {Vector3} v2 - Value to interpolate of second vertex.
   * @param {Vector3} v3 - Value to interpolate of third vertex.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The interpolated value.
   */
  getInterpolation(t, e, i, s, n) {
    return ot.getInterpolation(t, this.a, this.b, this.c, e, i, s, n);
  }
  /**
   * Returns `true` if the given point, when projected onto the plane of the
   * triangle, lies within the triangle.
   *
   * @param {Vector3} point - The point in 3D space to test.
   * @return {boolean} Whether the given point, when projected onto the plane of the
   * triangle, lies within the triangle or not.
   */
  containsPoint(t) {
    return ot.containsPoint(t, this.a, this.b, this.c);
  }
  /**
   * Returns `true` if the triangle is oriented towards the given direction.
   *
   * @param {Vector3} direction - The (normalized) direction vector.
   * @return {boolean} Whether the triangle is oriented towards the given direction or not.
   */
  isFrontFacing(t) {
    return ot.isFrontFacing(this.a, this.b, this.c, t);
  }
  /**
   * Returns `true` if this triangle intersects with the given box.
   *
   * @param {Box3} box - The box to intersect.
   * @return {boolean} Whether this triangle intersects with the given box or not.
   */
  intersectsBox(t) {
    return t.intersectsTriangle(this);
  }
  /**
   * Returns the closest point on the triangle to the given point.
   *
   * @param {Vector3} p - The point to compute the closest point for.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The closest point on the triangle.
   */
  closestPointToPoint(t, e) {
    const i = this.a, s = this.b, n = this.c;
    let r, a;
    jt.subVectors(s, i), Kt.subVectors(n, i), _i.subVectors(t, i);
    const o = jt.dot(_i), c = Kt.dot(_i);
    if (o <= 0 && c <= 0)
      return e.copy(i);
    Mi.subVectors(t, s);
    const h = jt.dot(Mi), l = Kt.dot(Mi);
    if (h >= 0 && l <= h)
      return e.copy(s);
    const u = o * l - h * c;
    if (u <= 0 && o >= 0 && h <= 0)
      return r = o / (o - h), e.copy(i).addScaledVector(jt, r);
    Ai.subVectors(t, n);
    const d = jt.dot(Ai), y = Kt.dot(Ai);
    if (y >= 0 && d <= y)
      return e.copy(n);
    const m = d * c - o * y;
    if (m <= 0 && c >= 0 && y <= 0)
      return a = c / (c - y), e.copy(i).addScaledVector(Kt, a);
    const z = h * y - d * l;
    if (z <= 0 && l - h >= 0 && d - y >= 0)
      return ws.subVectors(n, s), a = (l - h) / (l - h + (d - y)), e.copy(s).addScaledVector(ws, a);
    const b = 1 / (z + m + u);
    return r = m * b, a = u * b, e.copy(i).addScaledVector(jt, r).addScaledVector(Kt, a);
  }
  /**
   * Returns `true` if this triangle is equal with the given one.
   *
   * @param {Triangle} triangle - The triangle to test for equality.
   * @return {boolean} Whether this triangle is equal with the given one.
   */
  equals(t) {
    return t.a.equals(this.a) && t.b.equals(this.b) && t.c.equals(this.c);
  }
}
class Q {
  /**
   * Constructs a new bounding box.
   *
   * @param {Vector3} [min=(Infinity,Infinity,Infinity)] - A vector representing the lower boundary of the box.
   * @param {Vector3} [max=(-Infinity,-Infinity,-Infinity)] - A vector representing the upper boundary of the box.
   */
  constructor(t = new S(1 / 0, 1 / 0, 1 / 0), e = new S(-1 / 0, -1 / 0, -1 / 0)) {
    this.isBox3 = !0, this.min = t, this.max = e;
  }
  /**
   * Sets the lower and upper boundaries of this box.
   * Please note that this method only copies the values from the given objects.
   *
   * @param {Vector3} min - The lower boundary of the box.
   * @param {Vector3} max - The upper boundary of the box.
   * @return {Box3} A reference to this bounding box.
   */
  set(t, e) {
    return this.min.copy(t), this.max.copy(e), this;
  }
  /**
   * Sets the upper and lower bounds of this box so it encloses the position data
   * in the given array.
   *
   * @param {Array<number>} array - An array holding 3D position data.
   * @return {Box3} A reference to this bounding box.
   */
  setFromArray(t) {
    this.makeEmpty();
    for (let e = 0, i = t.length; e < i; e += 3)
      this.expandByPoint(ut.fromArray(t, e));
    return this;
  }
  /**
   * Sets the upper and lower bounds of this box so it encloses the position data
   * in the given buffer attribute.
   *
   * @param {BufferAttribute} attribute - A buffer attribute holding 3D position data.
   * @return {Box3} A reference to this bounding box.
   */
  setFromBufferAttribute(t) {
    this.makeEmpty();
    for (let e = 0, i = t.count; e < i; e++)
      this.expandByPoint(ut.fromBufferAttribute(t, e));
    return this;
  }
  /**
   * Sets the upper and lower bounds of this box so it encloses the position data
   * in the given array.
   *
   * @param {Array<Vector3>} points - An array holding 3D position data as instances of {@link Vector3}.
   * @return {Box3} A reference to this bounding box.
   */
  setFromPoints(t) {
    this.makeEmpty();
    for (let e = 0, i = t.length; e < i; e++)
      this.expandByPoint(t[e]);
    return this;
  }
  /**
   * Centers this box on the given center vector and sets this box's width, height and
   * depth to the given size values.
   *
   * @param {Vector3} center - The center of the box.
   * @param {Vector3} size - The x, y and z dimensions of the box.
   * @return {Box3} A reference to this bounding box.
   */
  setFromCenterAndSize(t, e) {
    const i = ut.copy(e).multiplyScalar(0.5);
    return this.min.copy(t).sub(i), this.max.copy(t).add(i), this;
  }
  /**
   * Computes the world-axis-aligned bounding box for the given 3D object
   * (including its children), accounting for the object's, and children's,
   * world transforms. The function may result in a larger box than strictly necessary.
   *
   * Note: To compute the correct bounding box, make sure the given 3D object
   * has an up-to-date world matrix that reflects the current transformation of its
   * ancestor nodes. Call `object.updateWorldMatrix( true, false )` beforehand if
   * you're unsure.
   *
   * @param {Object3D} object - The 3D object to compute the bounding box for.
   * @param {boolean} [precise=false] - If set to `true`, the method computes the smallest
   * world-axis-aligned bounding box at the expense of more computation.
   * @return {Box3} A reference to this bounding box.
   */
  setFromObject(t, e = !1) {
    return this.makeEmpty(), this.expandByObject(t, e);
  }
  /**
   * Returns a new box with copied values from this instance.
   *
   * @return {Box3} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Copies the values of the given box to this instance.
   *
   * @param {Box3} box - The box to copy.
   * @return {Box3} A reference to this bounding box.
   */
  copy(t) {
    return this.min.copy(t.min), this.max.copy(t.max), this;
  }
  /**
   * Makes this box empty which means in encloses a zero space in 3D.
   *
   * @return {Box3} A reference to this bounding box.
   */
  makeEmpty() {
    return this.min.x = this.min.y = this.min.z = 1 / 0, this.max.x = this.max.y = this.max.z = -1 / 0, this;
  }
  /**
   * Returns true if this box includes zero points within its bounds.
   * Note that a box with equal lower and upper bounds still includes one
   * point, the one both bounds share.
   *
   * @return {boolean} Whether this box is empty or not.
   */
  isEmpty() {
    return this.max.x < this.min.x || this.max.y < this.min.y || this.max.z < this.min.z;
  }
  /**
   * Returns the center point of this box.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The center point.
   */
  getCenter(t) {
    return this.isEmpty() ? t.set(0, 0, 0) : t.addVectors(this.min, this.max).multiplyScalar(0.5);
  }
  /**
   * Returns the dimensions of this box.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The size.
   */
  getSize(t) {
    return this.isEmpty() ? t.set(0, 0, 0) : t.subVectors(this.max, this.min);
  }
  /**
   * Expands the boundaries of this box to include the given point.
   *
   * @param {Vector3} point - The point that should be included by the bounding box.
   * @return {Box3} A reference to this bounding box.
   */
  expandByPoint(t) {
    return this.min.min(t), this.max.max(t), this;
  }
  /**
   * Expands this box equilaterally by the given vector. The width of this
   * box will be expanded by the x component of the vector in both
   * directions. The height of this box will be expanded by the y component of
   * the vector in both directions. The depth of this box will be
   * expanded by the z component of the vector in both directions.
   *
   * @param {Vector3} vector - The vector that should expand the bounding box.
   * @return {Box3} A reference to this bounding box.
   */
  expandByVector(t) {
    return this.min.sub(t), this.max.add(t), this;
  }
  /**
   * Expands each dimension of the box by the given scalar. If negative, the
   * dimensions of the box will be contracted.
   *
   * @param {number} scalar - The scalar value that should expand the bounding box.
   * @return {Box3} A reference to this bounding box.
   */
  expandByScalar(t) {
    return this.min.addScalar(-t), this.max.addScalar(t), this;
  }
  /**
   * Expands the boundaries of this box to include the given 3D object and
   * its children, accounting for the object's, and children's, world
   * transforms. The function may result in a larger box than strictly
   * necessary (unless the precise parameter is set to true).
   *
   * @param {Object3D} object - The 3D object that should expand the bounding box.
   * @param {boolean} precise - If set to `true`, the method expands the bounding box
   * as little as necessary at the expense of more computation.
   * @return {Box3} A reference to this bounding box.
   */
  expandByObject(t, e = !1) {
    t.updateWorldMatrix(!1, !1);
    const i = t.geometry;
    if (i !== void 0) {
      const n = i.getAttribute("position");
      if (e === !0 && n !== void 0 && t.isInstancedMesh !== !0)
        for (let r = 0, a = n.count; r < a; r++)
          t.isMesh === !0 ? t.getVertexPosition(r, ut) : ut.fromBufferAttribute(n, r), ut.applyMatrix4(t.matrixWorld), this.expandByPoint(ut);
      else
        t.boundingBox !== void 0 ? (t.boundingBox === null && t.computeBoundingBox(), Ne.copy(t.boundingBox)) : (i.boundingBox === null && i.computeBoundingBox(), Ne.copy(i.boundingBox)), Ne.applyMatrix4(t.matrixWorld), this.union(Ne);
    }
    const s = t.children;
    for (let n = 0, r = s.length; n < r; n++)
      this.expandByObject(s[n], e);
    return this;
  }
  /**
   * Returns `true` if the given point lies within or on the boundaries of this box.
   *
   * @param {Vector3} point - The point to test.
   * @return {boolean} Whether the bounding box contains the given point or not.
   */
  containsPoint(t) {
    return t.x >= this.min.x && t.x <= this.max.x && t.y >= this.min.y && t.y <= this.max.y && t.z >= this.min.z && t.z <= this.max.z;
  }
  /**
   * Returns `true` if this bounding box includes the entirety of the given bounding box.
   * If this box and the given one are identical, this function also returns `true`.
   *
   * @param {Box3} box - The bounding box to test.
   * @return {boolean} Whether the bounding box contains the given bounding box or not.
   */
  containsBox(t) {
    return this.min.x <= t.min.x && t.max.x <= this.max.x && this.min.y <= t.min.y && t.max.y <= this.max.y && this.min.z <= t.min.z && t.max.z <= this.max.z;
  }
  /**
   * Returns a point as a proportion of this box's width, height and depth.
   *
   * @param {Vector3} point - A point in 3D space.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} A point as a proportion of this box's width, height and depth.
   */
  getParameter(t, e) {
    return e.set(
      (t.x - this.min.x) / (this.max.x - this.min.x),
      (t.y - this.min.y) / (this.max.y - this.min.y),
      (t.z - this.min.z) / (this.max.z - this.min.z)
    );
  }
  /**
   * Returns `true` if the given bounding box intersects with this bounding box.
   *
   * @param {Box3} box - The bounding box to test.
   * @return {boolean} Whether the given bounding box intersects with this bounding box.
   */
  intersectsBox(t) {
    return t.max.x >= this.min.x && t.min.x <= this.max.x && t.max.y >= this.min.y && t.min.y <= this.max.y && t.max.z >= this.min.z && t.min.z <= this.max.z;
  }
  /**
   * Returns `true` if the given bounding sphere intersects with this bounding box.
   *
   * @param {Sphere} sphere - The bounding sphere to test.
   * @return {boolean} Whether the given bounding sphere intersects with this bounding box.
   */
  intersectsSphere(t) {
    return this.clampPoint(t.center, ut), ut.distanceToSquared(t.center) <= t.radius * t.radius;
  }
  /**
   * Returns `true` if the given plane intersects with this bounding box.
   *
   * @param {Plane} plane - The plane to test.
   * @return {boolean} Whether the given plane intersects with this bounding box.
   */
  intersectsPlane(t) {
    let e, i;
    return t.normal.x > 0 ? (e = t.normal.x * this.min.x, i = t.normal.x * this.max.x) : (e = t.normal.x * this.max.x, i = t.normal.x * this.min.x), t.normal.y > 0 ? (e += t.normal.y * this.min.y, i += t.normal.y * this.max.y) : (e += t.normal.y * this.max.y, i += t.normal.y * this.min.y), t.normal.z > 0 ? (e += t.normal.z * this.min.z, i += t.normal.z * this.max.z) : (e += t.normal.z * this.max.z, i += t.normal.z * this.min.z), e <= -t.constant && i >= -t.constant;
  }
  /**
   * Returns `true` if the given triangle intersects with this bounding box.
   *
   * @param {Triangle} triangle - The triangle to test.
   * @return {boolean} Whether the given triangle intersects with this bounding box.
   */
  intersectsTriangle(t) {
    if (this.isEmpty())
      return !1;
    this.getCenter(we), Le.subVectors(this.max, we), te.subVectors(t.a, we), ee.subVectors(t.b, we), ie.subVectors(t.c, we), Ct.subVectors(ee, te), Et.subVectors(ie, ee), qt.subVectors(te, ie);
    let e = [
      0,
      -Ct.z,
      Ct.y,
      0,
      -Et.z,
      Et.y,
      0,
      -qt.z,
      qt.y,
      Ct.z,
      0,
      -Ct.x,
      Et.z,
      0,
      -Et.x,
      qt.z,
      0,
      -qt.x,
      -Ct.y,
      Ct.x,
      0,
      -Et.y,
      Et.x,
      0,
      -qt.y,
      qt.x,
      0
    ];
    return !Pi(e, te, ee, ie, Le) || (e = [1, 0, 0, 0, 1, 0, 0, 0, 1], !Pi(e, te, ee, ie, Le)) ? !1 : (De.crossVectors(Ct, Et), e = [De.x, De.y, De.z], Pi(e, te, ee, ie, Le));
  }
  /**
   * Clamps the given point within the bounds of this box.
   *
   * @param {Vector3} point - The point to clamp.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The clamped point.
   */
  clampPoint(t, e) {
    return e.copy(t).clamp(this.min, this.max);
  }
  /**
   * Returns the euclidean distance from any edge of this box to the specified point. If
   * the given point lies inside of this box, the distance will be `0`.
   *
   * @param {Vector3} point - The point to compute the distance to.
   * @return {number} The euclidean distance.
   */
  distanceToPoint(t) {
    return this.clampPoint(t, ut).distanceTo(t);
  }
  /**
   * Returns a bounding sphere that encloses this bounding box.
   *
   * @param {Sphere} target - The target sphere that is used to store the method's result.
   * @return {Sphere} The bounding sphere that encloses this bounding box.
   */
  getBoundingSphere(t) {
    return this.isEmpty() ? t.makeEmpty() : (this.getCenter(t.center), t.radius = this.getSize(ut).length() * 0.5), t;
  }
  /**
   * Computes the intersection of this bounding box and the given one, setting the upper
   * bound of this box to the lesser of the two boxes' upper bounds and the
   * lower bound of this box to the greater of the two boxes' lower bounds. If
   * there's no overlap, makes this box empty.
   *
   * @param {Box3} box - The bounding box to intersect with.
   * @return {Box3} A reference to this bounding box.
   */
  intersect(t) {
    return this.min.max(t.min), this.max.min(t.max), this.isEmpty() && this.makeEmpty(), this;
  }
  /**
   * Computes the union of this box and another and the given one, setting the upper
   * bound of this box to the greater of the two boxes' upper bounds and the
   * lower bound of this box to the lesser of the two boxes' lower bounds.
   *
   * @param {Box3} box - The bounding box that will be unioned with this instance.
   * @return {Box3} A reference to this bounding box.
   */
  union(t) {
    return this.min.min(t.min), this.max.max(t.max), this;
  }
  /**
   * Transforms this bounding box by the given 4x4 transformation matrix.
   *
   * @param {Matrix4} matrix - The transformation matrix.
   * @return {Box3} A reference to this bounding box.
   */
  applyMatrix4(t) {
    return this.isEmpty() ? this : (zt[0].set(this.min.x, this.min.y, this.min.z).applyMatrix4(t), zt[1].set(this.min.x, this.min.y, this.max.z).applyMatrix4(t), zt[2].set(this.min.x, this.max.y, this.min.z).applyMatrix4(t), zt[3].set(this.min.x, this.max.y, this.max.z).applyMatrix4(t), zt[4].set(this.max.x, this.min.y, this.min.z).applyMatrix4(t), zt[5].set(this.max.x, this.min.y, this.max.z).applyMatrix4(t), zt[6].set(this.max.x, this.max.y, this.min.z).applyMatrix4(t), zt[7].set(this.max.x, this.max.y, this.max.z).applyMatrix4(t), this.setFromPoints(zt), this);
  }
  /**
   * Adds the given offset to both the upper and lower bounds of this bounding box,
   * effectively moving it in 3D space.
   *
   * @param {Vector3} offset - The offset that should be used to translate the bounding box.
   * @return {Box3} A reference to this bounding box.
   */
  translate(t) {
    return this.min.add(t), this.max.add(t), this;
  }
  /**
   * Returns `true` if this bounding box is equal with the given one.
   *
   * @param {Box3} box - The box to test for equality.
   * @return {boolean} Whether this bounding box is equal with the given one.
   */
  equals(t) {
    return t.min.equals(this.min) && t.max.equals(this.max);
  }
  /**
   * Returns a serialized structure of the bounding box.
   *
   * @return {Object} Serialized structure with fields representing the object state.
   */
  toJSON() {
    return {
      min: this.min.toArray(),
      max: this.max.toArray()
    };
  }
  /**
   * Returns a serialized structure of the bounding box.
   *
   * @param {Object} json - The serialized json to set the box from.
   * @return {Box3} A reference to this bounding box.
   */
  fromJSON(t) {
    return this.min.fromArray(t.min), this.max.fromArray(t.max), this;
  }
}
const zt = [
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S(),
  /* @__PURE__ */ new S()
], ut = /* @__PURE__ */ new S(), Ne = /* @__PURE__ */ new Q(), te = /* @__PURE__ */ new S(), ee = /* @__PURE__ */ new S(), ie = /* @__PURE__ */ new S(), Ct = /* @__PURE__ */ new S(), Et = /* @__PURE__ */ new S(), qt = /* @__PURE__ */ new S(), we = /* @__PURE__ */ new S(), Le = /* @__PURE__ */ new S(), De = /* @__PURE__ */ new S(), vt = /* @__PURE__ */ new S();
function Pi(f, t, e, i, s) {
  for (let n = 0, r = f.length - 3; n <= r; n += 3) {
    vt.fromArray(f, n);
    const a = s.x * Math.abs(vt.x) + s.y * Math.abs(vt.y) + s.z * Math.abs(vt.z), o = t.dot(vt), c = e.dot(vt), h = i.dot(vt);
    if (Math.max(-Math.max(o, c, h), Math.min(o, c, h)) > a)
      return !1;
  }
  return !0;
}
const D = /* @__PURE__ */ new S(), qe = /* @__PURE__ */ new Z();
let on = 0;
class mt extends ci {
  /**
   * Constructs a new buffer attribute.
   *
   * @param {TypedArray} array - The array holding the attribute data.
   * @param {number} itemSize - The item size.
   * @param {boolean} [normalized=false] - Whether the data are normalized or not.
   */
  constructor(t, e, i = !1) {
    if (super(), Array.isArray(t))
      throw new TypeError("THREE.BufferAttribute: array should be a Typed Array.");
    this.isBufferAttribute = !0, Object.defineProperty(this, "id", { value: on++ }), this.name = "", this.array = t, this.itemSize = e, this.count = t !== void 0 ? t.length / e : 0, this.normalized = i, this.usage = 35044, this.updateRanges = [], this.gpuType = 1015, this.version = 0;
  }
  /**
   * A callback function that is executed after the renderer has transferred the attribute
   * array data to the GPU.
   */
  onUploadCallback() {
  }
  /**
   * Flag to indicate that this attribute has changed and should be re-sent to
   * the GPU. Set this to `true` when you modify the value of the array.
   *
   * @type {number}
   * @default false
   * @param {boolean} value
   */
  set needsUpdate(t) {
    t === !0 && this.version++;
  }
  /**
   * Sets the usage of this buffer attribute.
   *
   * @param {(StaticDrawUsage|DynamicDrawUsage|StreamDrawUsage|StaticReadUsage|DynamicReadUsage|StreamReadUsage|StaticCopyUsage|DynamicCopyUsage|StreamCopyUsage)} value - The usage to set.
   * @return {BufferAttribute} A reference to this buffer attribute.
   */
  setUsage(t) {
    return this.usage = t, this;
  }
  /**
   * Adds a range of data in the data array to be updated on the GPU.
   *
   * @param {number} start - Position at which to start update.
   * @param {number} count - The number of components to update.
   */
  addUpdateRange(t, e) {
    this.updateRanges.push({ start: t, count: e });
  }
  /**
   * Clears the update ranges.
   */
  clearUpdateRanges() {
    this.updateRanges.length = 0;
  }
  /**
   * Copies the values of the given buffer attribute to this instance.
   *
   * @param {BufferAttribute} source - The buffer attribute to copy.
   * @return {BufferAttribute} A reference to this instance.
   */
  copy(t) {
    return this.name = t.name, this.array = new t.array.constructor(t.array), this.itemSize = t.itemSize, this.count = t.count, this.normalized = t.normalized, this.usage = t.usage, this.gpuType = t.gpuType, this;
  }
  /**
   * Copies a vector from the given buffer attribute to this one. The start
   * and destination position in the attribute buffers are represented by the
   * given indices.
   *
   * @param {number} index1 - The destination index into this buffer attribute.
   * @param {BufferAttribute} attribute - The buffer attribute to copy from.
   * @param {number} index2 - The source index into the given buffer attribute.
   * @return {BufferAttribute} A reference to this instance.
   */
  copyAt(t, e, i) {
    t *= this.itemSize, i *= e.itemSize;
    for (let s = 0, n = this.itemSize; s < n; s++)
      this.array[t + s] = e.array[i + s];
    return this;
  }
  /**
   * Copies the given array data into this buffer attribute.
   *
   * @param {(TypedArray|Array)} array - The array to copy.
   * @return {BufferAttribute} A reference to this instance.
   */
  copyArray(t) {
    return this.array.set(t), this;
  }
  /**
   * Applies the given 3x3 matrix to the given attribute. Works with
   * item size `2` and `3`.
   *
   * @param {Matrix3} m - The matrix to apply.
   * @return {BufferAttribute} A reference to this instance.
   */
  applyMatrix3(t) {
    if (this.itemSize === 2)
      for (let e = 0, i = this.count; e < i; e++)
        qe.fromBufferAttribute(this, e), qe.applyMatrix3(t), this.setXY(e, qe.x, qe.y);
    else if (this.itemSize === 3)
      for (let e = 0, i = this.count; e < i; e++)
        D.fromBufferAttribute(this, e), D.applyMatrix3(t), this.setXYZ(e, D.x, D.y, D.z);
    return this;
  }
  /**
   * Applies the given 4x4 matrix to the given attribute. Only works with
   * item size `3`.
   *
   * @param {Matrix4} m - The matrix to apply.
   * @return {BufferAttribute} A reference to this instance.
   */
  applyMatrix4(t) {
    for (let e = 0, i = this.count; e < i; e++)
      D.fromBufferAttribute(this, e), D.applyMatrix4(t), this.setXYZ(e, D.x, D.y, D.z);
    return this;
  }
  /**
   * Applies the given 3x3 normal matrix to the given attribute. Only works with
   * item size `3`.
   *
   * @param {Matrix3} m - The normal matrix to apply.
   * @return {BufferAttribute} A reference to this instance.
   */
  applyNormalMatrix(t) {
    for (let e = 0, i = this.count; e < i; e++)
      D.fromBufferAttribute(this, e), D.applyNormalMatrix(t), this.setXYZ(e, D.x, D.y, D.z);
    return this;
  }
  /**
   * Applies the given 4x4 matrix to the given attribute. Only works with
   * item size `3` and with direction vectors.
   *
   * @param {Matrix4} m - The matrix to apply.
   * @return {BufferAttribute} A reference to this instance.
   */
  transformDirection(t) {
    for (let e = 0, i = this.count; e < i; e++)
      D.fromBufferAttribute(this, e), D.transformDirection(t), this.setXYZ(e, D.x, D.y, D.z);
    return this;
  }
  /**
   * Sets the given array data in the buffer attribute.
   *
   * @param {(TypedArray|Array)} value - The array data to set.
   * @param {number} [offset=0] - The offset in this buffer attribute's array.
   * @return {BufferAttribute} A reference to this instance.
   */
  set(t, e = 0) {
    return this.array.set(t, e), this;
  }
  /**
   * Returns the given component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} component - The component index.
   * @return {number} The returned value.
   */
  getComponent(t, e) {
    let i = this.array[t * this.itemSize + e];
    return this.normalized && (i = xe(i, this.array)), i;
  }
  /**
   * Sets the given value to the given component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} component - The component index.
   * @param {number} value - The value to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setComponent(t, e, i) {
    return this.normalized && (i = tt(i, this.array)), this.array[t * this.itemSize + e] = i, this;
  }
  /**
   * Returns the x component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @return {number} The x component.
   */
  getX(t) {
    let e = this.array[t * this.itemSize];
    return this.normalized && (e = xe(e, this.array)), e;
  }
  /**
   * Sets the x component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} x - The value to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setX(t, e) {
    return this.normalized && (e = tt(e, this.array)), this.array[t * this.itemSize] = e, this;
  }
  /**
   * Returns the y component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @return {number} The y component.
   */
  getY(t) {
    let e = this.array[t * this.itemSize + 1];
    return this.normalized && (e = xe(e, this.array)), e;
  }
  /**
   * Sets the y component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} y - The value to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setY(t, e) {
    return this.normalized && (e = tt(e, this.array)), this.array[t * this.itemSize + 1] = e, this;
  }
  /**
   * Returns the z component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @return {number} The z component.
   */
  getZ(t) {
    let e = this.array[t * this.itemSize + 2];
    return this.normalized && (e = xe(e, this.array)), e;
  }
  /**
   * Sets the z component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} z - The value to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setZ(t, e) {
    return this.normalized && (e = tt(e, this.array)), this.array[t * this.itemSize + 2] = e, this;
  }
  /**
   * Returns the w component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @return {number} The w component.
   */
  getW(t) {
    let e = this.array[t * this.itemSize + 3];
    return this.normalized && (e = xe(e, this.array)), e;
  }
  /**
   * Sets the w component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} w - The value to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setW(t, e) {
    return this.normalized && (e = tt(e, this.array)), this.array[t * this.itemSize + 3] = e, this;
  }
  /**
   * Sets the x and y component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} x - The value for the x component to set.
   * @param {number} y - The value for the y component to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setXY(t, e, i) {
    return t *= this.itemSize, this.normalized && (e = tt(e, this.array), i = tt(i, this.array)), this.array[t + 0] = e, this.array[t + 1] = i, this;
  }
  /**
   * Sets the x, y and z component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} x - The value for the x component to set.
   * @param {number} y - The value for the y component to set.
   * @param {number} z - The value for the z component to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setXYZ(t, e, i, s) {
    return t *= this.itemSize, this.normalized && (e = tt(e, this.array), i = tt(i, this.array), s = tt(s, this.array)), this.array[t + 0] = e, this.array[t + 1] = i, this.array[t + 2] = s, this;
  }
  /**
   * Sets the x, y, z and w component of the vector at the given index.
   *
   * @param {number} index - The index into the buffer attribute.
   * @param {number} x - The value for the x component to set.
   * @param {number} y - The value for the y component to set.
   * @param {number} z - The value for the z component to set.
   * @param {number} w - The value for the w component to set.
   * @return {BufferAttribute} A reference to this instance.
   */
  setXYZW(t, e, i, s, n) {
    return t *= this.itemSize, this.normalized && (e = tt(e, this.array), i = tt(i, this.array), s = tt(s, this.array), n = tt(n, this.array)), this.array[t + 0] = e, this.array[t + 1] = i, this.array[t + 2] = s, this.array[t + 3] = n, this;
  }
  /**
   * Sets the given callback function that is executed after the Renderer has transferred
   * the attribute array data to the GPU. Can be used to perform clean-up operations after
   * the upload when attribute data are not needed anymore on the CPU side.
   *
   * @param {Function} callback - The `onUpload()` callback.
   * @return {BufferAttribute} A reference to this instance.
   */
  onUpload(t) {
    return this.onUploadCallback = t, this;
  }
  /**
   * Returns a new buffer attribute with copied values from this instance.
   *
   * @return {BufferAttribute} A clone of this instance.
   */
  clone() {
    return new this.constructor(this.array, this.itemSize).copy(this);
  }
  /**
   * Serializes the buffer attribute into JSON.
   *
   * @return {Object} A JSON object representing the serialized buffer attribute.
   */
  toJSON() {
    const t = {
      itemSize: this.itemSize,
      type: this.array.constructor.name,
      array: Array.from(this.array),
      normalized: this.normalized
    };
    return t.name = this.name, t.usage = this.usage, t.gpuType = this.gpuType, t;
  }
  /**
   * Disposes of the buffer attribute. Available only in {@link WebGPURenderer}.
   */
  dispose() {
    this.dispatchEvent({ type: "dispose" });
  }
}
class an extends mt {
  /**
   * Constructs a new buffer attribute.
   *
   * @param {(Array<number>|Uint16Array)} array - The array holding the attribute data.
   * @param {number} itemSize - The item size.
   * @param {boolean} [normalized=false] - Whether the data are normalized or not.
   */
  constructor(t, e, i) {
    super(new Uint16Array(t), e, i);
  }
}
class cn extends mt {
  /**
   * Constructs a new buffer attribute.
   *
   * @param {(Array<number>|Uint32Array)} array - The array holding the attribute data.
   * @param {number} itemSize - The item size.
   * @param {boolean} [normalized=false] - Whether the data are normalized or not.
   */
  constructor(t, e, i) {
    super(new Uint32Array(t), e, i);
  }
}
class hn extends mt {
  /**
   * Constructs a new buffer attribute.
   *
   * @param {(Array<number>|Float32Array)} array - The array holding the attribute data.
   * @param {number} itemSize - The item size.
   * @param {boolean} [normalized=false] - Whether the data are normalized or not.
   */
  constructor(t, e, i) {
    super(new Float32Array(t), e, i);
  }
}
const ln = /* @__PURE__ */ new Q(), be = /* @__PURE__ */ new S(), Ci = /* @__PURE__ */ new S();
class un {
  /**
   * Constructs a new sphere.
   *
   * @param {Vector3} [center=(0,0,0)] - The center of the sphere
   * @param {number} [radius=-1] - The radius of the sphere.
   */
  constructor(t = new S(), e = -1) {
    this.isSphere = !0, this.center = t, this.radius = e;
  }
  /**
   * Sets the sphere's components by copying the given values.
   *
   * @param {Vector3} center - The center.
   * @param {number} radius - The radius.
   * @return {Sphere} A reference to this sphere.
   */
  set(t, e) {
    return this.center.copy(t), this.radius = e, this;
  }
  /**
   * Computes the minimum bounding sphere for list of points.
   * If the optional center point is given, it is used as the sphere's
   * center. Otherwise, the center of the axis-aligned bounding box
   * encompassing the points is calculated.
   *
   * @param {Array<Vector3>} points - A list of points in 3D space.
   * @param {Vector3} [optionalCenter] - The center of the sphere.
   * @return {Sphere} A reference to this sphere.
   */
  setFromPoints(t, e) {
    const i = this.center;
    e !== void 0 ? i.copy(e) : ln.setFromPoints(t).getCenter(i);
    let s = 0;
    for (let n = 0, r = t.length; n < r; n++)
      s = Math.max(s, i.distanceToSquared(t[n]));
    return this.radius = Math.sqrt(s), this;
  }
  /**
   * Copies the values of the given sphere to this instance.
   *
   * @param {Sphere} sphere - The sphere to copy.
   * @return {Sphere} A reference to this sphere.
   */
  copy(t) {
    return this.center.copy(t.center), this.radius = t.radius, this;
  }
  /**
   * Returns `true` if the sphere is empty (the radius set to a negative number).
   *
   * Spheres with a radius of `0` contain only their center point and are not
   * considered to be empty.
   *
   * @return {boolean} Whether this sphere is empty or not.
   */
  isEmpty() {
    return this.radius < 0;
  }
  /**
   * Makes this sphere empty which means in encloses a zero space in 3D.
   *
   * @return {Sphere} A reference to this sphere.
   */
  makeEmpty() {
    return this.center.set(0, 0, 0), this.radius = -1, this;
  }
  /**
   * Returns `true` if this sphere contains the given point inclusive of
   * the surface of the sphere.
   *
   * @param {Vector3} point - The point to check.
   * @return {boolean} Whether this sphere contains the given point or not.
   */
  containsPoint(t) {
    return t.distanceToSquared(this.center) <= this.radius * this.radius;
  }
  /**
   * Returns the closest distance from the boundary of the sphere to the
   * given point. If the sphere contains the point, the distance will
   * be negative.
   *
   * @param {Vector3} point - The point to compute the distance to.
   * @return {number} The distance to the point.
   */
  distanceToPoint(t) {
    return t.distanceTo(this.center) - this.radius;
  }
  /**
   * Returns `true` if this sphere intersects with the given one.
   *
   * @param {Sphere} sphere - The sphere to test.
   * @return {boolean} Whether this sphere intersects with the given one or not.
   */
  intersectsSphere(t) {
    const e = this.radius + t.radius;
    return t.center.distanceToSquared(this.center) <= e * e;
  }
  /**
   * Returns `true` if this sphere intersects with the given box.
   *
   * @param {Box3} box - The box to test.
   * @return {boolean} Whether this sphere intersects with the given box or not.
   */
  intersectsBox(t) {
    return t.intersectsSphere(this);
  }
  /**
   * Returns `true` if this sphere intersects with the given plane.
   *
   * @param {Plane} plane - The plane to test.
   * @return {boolean} Whether this sphere intersects with the given plane or not.
   */
  intersectsPlane(t) {
    return Math.abs(t.distanceToPoint(this.center)) <= this.radius;
  }
  /**
   * Clamps a point within the sphere. If the point is outside the sphere, it
   * will clamp it to the closest point on the edge of the sphere. Points
   * already inside the sphere will not be affected.
   *
   * @param {Vector3} point - The plane to clamp.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The clamped point.
   */
  clampPoint(t, e) {
    const i = this.center.distanceToSquared(t);
    return e.copy(t), i > this.radius * this.radius && (e.sub(this.center).normalize(), e.multiplyScalar(this.radius).add(this.center)), e;
  }
  /**
   * Returns a bounding box that encloses this sphere.
   *
   * @param {Box3} target - The target box that is used to store the method's result.
   * @return {Box3} The bounding box that encloses this sphere.
   */
  getBoundingBox(t) {
    return this.isEmpty() ? (t.makeEmpty(), t) : (t.set(this.center, this.center), t.expandByScalar(this.radius), t);
  }
  /**
   * Transforms this sphere with the given 4x4 transformation matrix.
   *
   * @param {Matrix4} matrix - The transformation matrix.
   * @return {Sphere} A reference to this sphere.
   */
  applyMatrix4(t) {
    return this.center.applyMatrix4(t), this.radius = this.radius * t.getMaxScaleOnAxis(), this;
  }
  /**
   * Translates the sphere's center by the given offset.
   *
   * @param {Vector3} offset - The offset.
   * @return {Sphere} A reference to this sphere.
   */
  translate(t) {
    return this.center.add(t), this;
  }
  /**
   * Expands the boundaries of this sphere to include the given point.
   *
   * @param {Vector3} point - The point to include.
   * @return {Sphere} A reference to this sphere.
   */
  expandByPoint(t) {
    if (this.isEmpty())
      return this.center.copy(t), this.radius = 0, this;
    be.subVectors(t, this.center);
    const e = be.lengthSq();
    if (e > this.radius * this.radius) {
      const i = Math.sqrt(e), s = (i - this.radius) * 0.5;
      this.center.addScaledVector(be, s / i), this.radius += s;
    }
    return this;
  }
  /**
   * Expands this sphere to enclose both the original sphere and the given sphere.
   *
   * @param {Sphere} sphere - The sphere to include.
   * @return {Sphere} A reference to this sphere.
   */
  union(t) {
    return t.isEmpty() ? this : this.isEmpty() ? (this.copy(t), this) : (this.center.equals(t.center) === !0 ? this.radius = Math.max(this.radius, t.radius) : (Ci.subVectors(t.center, this.center).setLength(t.radius), this.expandByPoint(be.copy(t.center).add(Ci)), this.expandByPoint(be.copy(t.center).sub(Ci))), this);
  }
  /**
   * Returns `true` if this sphere is equal with the given one.
   *
   * @param {Sphere} sphere - The sphere to test for equality.
   * @return {boolean} Whether this bounding sphere is equal with the given one.
   */
  equals(t) {
    return t.center.equals(this.center) && t.radius === this.radius;
  }
  /**
   * Returns a new sphere with copied values from this instance.
   *
   * @return {Sphere} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Returns a serialized structure of the bounding sphere.
   *
   * @return {Object} Serialized structure with fields representing the object state.
   */
  toJSON() {
    return {
      radius: this.radius,
      center: this.center.toArray()
    };
  }
  /**
   * Returns a serialized structure of the bounding sphere.
   *
   * @param {Object} json - The serialized json to set the sphere from.
   * @return {Sphere} A reference to this bounding sphere.
   */
  fromJSON(t) {
    return this.radius = t.radius, this.center.fromArray(t.center), this;
  }
}
let fn = 0;
const nt = /* @__PURE__ */ new H(), Ei = /* @__PURE__ */ new kt(), se = /* @__PURE__ */ new S(), it = /* @__PURE__ */ new Q(), ze = /* @__PURE__ */ new Q(), X = /* @__PURE__ */ new S();
class ss extends ci {
  /**
   * Constructs a new geometry.
   */
  constructor() {
    super(), this.isBufferGeometry = !0, Object.defineProperty(this, "id", { value: fn++ }), this.uuid = hi(), this.name = "", this.type = "BufferGeometry", this.index = null, this.indirect = null, this.indirectOffset = 0, this.attributes = {}, this.morphAttributes = {}, this.morphTargetsRelative = !1, this.groups = [], this.boundingBox = null, this.boundingSphere = null, this.drawRange = { start: 0, count: 1 / 0 }, this.userData = {}, this._transformed = !1;
  }
  /**
   * Returns the index of this geometry.
   *
   * @return {?BufferAttribute} The index. Returns `null` if no index is defined.
   */
  getIndex() {
    return this.index;
  }
  /**
   * Sets the given index to this geometry.
   *
   * @param {Array<number>|BufferAttribute} index - The index to set.
   * @return {BufferGeometry} A reference to this instance.
   */
  setIndex(t) {
    return Array.isArray(t) ? this.index = new (Zs(t) ? cn : an)(t, 1) : this.index = t, this;
  }
  /**
   * Sets the given indirect attribute to this geometry.
   *
   * @param {BufferAttribute} indirect - The attribute holding indirect draw calls.
   * @param {number|Array<number>} [indirectOffset=0] - The offset, in bytes, into the indirect drawing buffer where the value data begins. If an array is provided, multiple indirect draw calls will be made for each offset.
   * @return {BufferGeometry} A reference to this instance.
   */
  setIndirect(t, e = 0) {
    return this.indirect = t, this.indirectOffset = e, this;
  }
  /**
   * Returns the indirect attribute of this geometry.
   *
   * @return {?BufferAttribute} The indirect attribute. Returns `null` if no indirect attribute is defined.
   */
  getIndirect() {
    return this.indirect;
  }
  /**
   * Returns the buffer attribute for the given name.
   *
   * @param {string} name - The attribute name.
   * @return {BufferAttribute|InterleavedBufferAttribute|undefined} The buffer attribute.
   * Returns `undefined` if not attribute has been found.
   */
  getAttribute(t) {
    return this.attributes[t];
  }
  /**
   * Sets the given attribute for the given name.
   *
   * @param {string} name - The attribute name.
   * @param {BufferAttribute|InterleavedBufferAttribute} attribute - The attribute to set.
   * @return {BufferGeometry} A reference to this instance.
   */
  setAttribute(t, e) {
    return this.attributes[t] = e, this;
  }
  /**
   * Deletes the attribute for the given name.
   *
   * @param {string} name - The attribute name to delete.
   * @return {BufferGeometry} A reference to this instance.
   */
  deleteAttribute(t) {
    return delete this.attributes[t], this;
  }
  /**
   * Returns `true` if this geometry has an attribute for the given name.
   *
   * @param {string} name - The attribute name.
   * @return {boolean} Whether this geometry has an attribute for the given name or not.
   */
  hasAttribute(t) {
    return this.attributes[t] !== void 0;
  }
  /**
   * Adds a group to this geometry.
   *
   * @param {number} start - The first element in this draw call. That is the first
   * vertex for non-indexed geometry, otherwise the first triangle index.
   * @param {number} count - Specifies how many vertices (or indices) are part of this group.
   * @param {number} [materialIndex=0] - The material array index to use.
   */
  addGroup(t, e, i = 0) {
    this.groups.push({
      start: t,
      count: e,
      materialIndex: i
    });
  }
  /**
   * Clears all groups.
   */
  clearGroups() {
    this.groups = [];
  }
  /**
   * Sets the draw range for this geometry.
   *
   * @param {number} start - The first vertex for non-indexed geometry, otherwise the first triangle index.
   * @param {number} count - For non-indexed BufferGeometry, `count` is the number of vertices to render.
   * For indexed BufferGeometry, `count` is the number of indices to render.
   */
  setDrawRange(t, e) {
    this.drawRange.start = t, this.drawRange.count = e;
  }
  /**
   * Applies the given 4x4 transformation matrix to the geometry.
   *
   * @param {Matrix4} matrix - The matrix to apply.
   * @return {BufferGeometry} A reference to this instance.
   */
  applyMatrix4(t) {
    const e = this.attributes.position;
    e !== void 0 && (e.applyMatrix4(t), e.needsUpdate = !0);
    const i = this.attributes.normal;
    if (i !== void 0) {
      const n = new Tt().getNormalMatrix(t);
      i.applyNormalMatrix(n), i.needsUpdate = !0;
    }
    const s = this.attributes.tangent;
    return s !== void 0 && (s.transformDirection(t), s.needsUpdate = !0), this.boundingBox !== null && this.computeBoundingBox(), this.boundingSphere !== null && this.computeBoundingSphere(), this._transformed = !0, this;
  }
  /**
   * Applies the rotation represented by the Quaternion to the geometry.
   *
   * @param {Quaternion} q - The Quaternion to apply.
   * @return {BufferGeometry} A reference to this instance.
   */
  applyQuaternion(t) {
    return nt.makeRotationFromQuaternion(t), this.applyMatrix4(nt), this;
  }
  /**
   * Rotates the geometry about the X axis. This is typically done as a one time
   * operation, and not during a loop. Use {@link Object3D#rotation} for typical
   * real-time mesh rotation.
   *
   * @param {number} angle - The angle in radians.
   * @return {BufferGeometry} A reference to this instance.
   */
  rotateX(t) {
    return nt.makeRotationX(t), this.applyMatrix4(nt), this;
  }
  /**
   * Rotates the geometry about the Y axis. This is typically done as a one time
   * operation, and not during a loop. Use {@link Object3D#rotation} for typical
   * real-time mesh rotation.
   *
   * @param {number} angle - The angle in radians.
   * @return {BufferGeometry} A reference to this instance.
   */
  rotateY(t) {
    return nt.makeRotationY(t), this.applyMatrix4(nt), this;
  }
  /**
   * Rotates the geometry about the Z axis. This is typically done as a one time
   * operation, and not during a loop. Use {@link Object3D#rotation} for typical
   * real-time mesh rotation.
   *
   * @param {number} angle - The angle in radians.
   * @return {BufferGeometry} A reference to this instance.
   */
  rotateZ(t) {
    return nt.makeRotationZ(t), this.applyMatrix4(nt), this;
  }
  /**
   * Translates the geometry. This is typically done as a one time
   * operation, and not during a loop. Use {@link Object3D#position} for typical
   * real-time mesh rotation.
   *
   * @param {number} x - The x offset.
   * @param {number} y - The y offset.
   * @param {number} z - The z offset.
   * @return {BufferGeometry} A reference to this instance.
   */
  translate(t, e, i) {
    return nt.makeTranslation(t, e, i), this.applyMatrix4(nt), this;
  }
  /**
   * Scales the geometry. This is typically done as a one time
   * operation, and not during a loop. Use {@link Object3D#scale} for typical
   * real-time mesh rotation.
   *
   * @param {number} x - The x scale.
   * @param {number} y - The y scale.
   * @param {number} z - The z scale.
   * @return {BufferGeometry} A reference to this instance.
   */
  scale(t, e, i) {
    return nt.makeScale(t, e, i), this.applyMatrix4(nt), this;
  }
  /**
   * Rotates the geometry to face a point in 3D space. This is typically done as a one time
   * operation, and not during a loop. Use {@link Object3D#lookAt} for typical
   * real-time mesh rotation.
   *
   * @param {Vector3} vector - The target point.
   * @return {BufferGeometry} A reference to this instance.
   */
  lookAt(t) {
    return Ei.lookAt(t), Ei.updateMatrix(), this.applyMatrix4(Ei.matrix), this;
  }
  /**
   * Center the geometry based on its bounding box.
   *
   * @return {BufferGeometry} A reference to this instance.
   */
  center() {
    return this.computeBoundingBox(), this.boundingBox.getCenter(se).negate(), this.translate(se.x, se.y, se.z), this;
  }
  /**
   * Defines a geometry by creating a `position` attribute based on the given array of points. The array
   * can hold 2D or 3D vectors. When using two-dimensional data, the `z` coordinate for all vertices is
   * set to `0`.
   *
   * If the method is used with an existing `position` attribute, the vertex data are overwritten with the
   * data from the array. The length of the array must match the vertex count.
   *
   * @param {Array<Vector2>|Array<Vector3>} points - The points.
   * @return {BufferGeometry} A reference to this instance.
   */
  setFromPoints(t) {
    const e = this.getAttribute("position");
    if (e === void 0) {
      const i = [];
      for (let s = 0, n = t.length; s < n; s++) {
        const r = t[s];
        i.push(r.x, r.y, r.z || 0);
      }
      this.setAttribute("position", new hn(i, 3));
    } else {
      const i = Math.min(t.length, e.count);
      for (let s = 0; s < i; s++) {
        const n = t[s];
        e.setXYZ(s, n.x, n.y, n.z || 0);
      }
      t.length > e.count && pt("BufferGeometry: Buffer size too small for points data. Use .dispose() and create a new geometry."), e.needsUpdate = !0;
    }
    return this;
  }
  /**
   * Computes the bounding box of the geometry, and updates the `boundingBox` member.
   * The bounding box is not computed by the engine; it must be computed by your app.
   * You may need to recompute the bounding box if the geometry vertices are modified.
   */
  computeBoundingBox() {
    this.boundingBox === null && (this.boundingBox = new Q());
    const t = this.attributes.position, e = this.morphAttributes.position;
    if (t && t.isGLBufferAttribute) {
      Yt("BufferGeometry.computeBoundingBox(): GLBufferAttribute requires a manual bounding box.", this), this.boundingBox.set(
        new S(-1 / 0, -1 / 0, -1 / 0),
        new S(1 / 0, 1 / 0, 1 / 0)
      );
      return;
    }
    if (t !== void 0) {
      if (this.boundingBox.setFromBufferAttribute(t), e)
        for (let i = 0, s = e.length; i < s; i++) {
          const n = e[i];
          it.setFromBufferAttribute(n), this.morphTargetsRelative ? (X.addVectors(this.boundingBox.min, it.min), this.boundingBox.expandByPoint(X), X.addVectors(this.boundingBox.max, it.max), this.boundingBox.expandByPoint(X)) : (this.boundingBox.expandByPoint(it.min), this.boundingBox.expandByPoint(it.max));
        }
    } else
      this.boundingBox.makeEmpty();
    (isNaN(this.boundingBox.min.x) || isNaN(this.boundingBox.min.y) || isNaN(this.boundingBox.min.z)) && Yt('BufferGeometry.computeBoundingBox(): Computed min/max have NaN values. The "position" attribute is likely to have NaN values.', this);
  }
  /**
   * Computes the bounding sphere of the geometry, and updates the `boundingSphere` member.
   * The engine automatically computes the bounding sphere when it is needed, e.g., for ray casting or view frustum culling.
   * You may need to recompute the bounding sphere if the geometry vertices are modified.
   */
  computeBoundingSphere() {
    this.boundingSphere === null && (this.boundingSphere = new un());
    const t = this.attributes.position, e = this.morphAttributes.position;
    if (t && t.isGLBufferAttribute) {
      Yt("BufferGeometry.computeBoundingSphere(): GLBufferAttribute requires a manual bounding sphere.", this), this.boundingSphere.set(new S(), 1 / 0);
      return;
    }
    if (t) {
      const i = this.boundingSphere.center;
      if (it.setFromBufferAttribute(t), e)
        for (let n = 0, r = e.length; n < r; n++) {
          const a = e[n];
          ze.setFromBufferAttribute(a), this.morphTargetsRelative ? (X.addVectors(it.min, ze.min), it.expandByPoint(X), X.addVectors(it.max, ze.max), it.expandByPoint(X)) : (it.expandByPoint(ze.min), it.expandByPoint(ze.max));
        }
      it.getCenter(i);
      let s = 0;
      for (let n = 0, r = t.count; n < r; n++)
        X.fromBufferAttribute(t, n), s = Math.max(s, i.distanceToSquared(X));
      if (e)
        for (let n = 0, r = e.length; n < r; n++) {
          const a = e[n], o = this.morphTargetsRelative;
          for (let c = 0, h = a.count; c < h; c++)
            X.fromBufferAttribute(a, c), o && (se.fromBufferAttribute(t, c), X.add(se)), s = Math.max(s, i.distanceToSquared(X));
        }
      this.boundingSphere.radius = Math.sqrt(s), isNaN(this.boundingSphere.radius) && Yt('BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.', this);
    }
  }
  /**
   * Calculates and adds a tangent attribute to this geometry.
   *
   * The computation is only supported for indexed geometries and if position, normal, and uv attributes
   * are defined. When using a tangent space normal map, prefer the MikkTSpace algorithm provided by
   * {@link BufferGeometryUtils#computeMikkTSpaceTangents} instead.
   */
  computeTangents() {
    const t = this.index, e = this.attributes;
    if (t === null || e.position === void 0 || e.normal === void 0 || e.uv === void 0) {
      Yt("BufferGeometry: .computeTangents() failed. Missing required attributes (index, position, normal or uv)");
      return;
    }
    const i = e.position, s = e.normal, n = e.uv;
    let r = this.getAttribute("tangent");
    (r === void 0 || r.count !== i.count) && (r = new mt(new Float32Array(4 * i.count), 4), this.setAttribute("tangent", r));
    const a = [], o = [];
    for (let M = 0; M < i.count; M++)
      a[M] = new S(), o[M] = new S();
    const c = new S(), h = new S(), l = new S(), u = new Z(), d = new Z(), y = new Z(), m = new S(), z = new S();
    function b(M, P, A) {
      c.fromBufferAttribute(i, M), h.fromBufferAttribute(i, P), l.fromBufferAttribute(i, A), u.fromBufferAttribute(n, M), d.fromBufferAttribute(n, P), y.fromBufferAttribute(n, A), h.sub(c), l.sub(c), d.sub(u), y.sub(u);
      const C = 1 / (d.x * y.y - y.x * d.y);
      isFinite(C) && (m.copy(h).multiplyScalar(y.y).addScaledVector(l, -d.y).multiplyScalar(C), z.copy(l).multiplyScalar(d.x).addScaledVector(h, -y.x).multiplyScalar(C), a[M].add(m), a[P].add(m), a[A].add(m), o[M].add(z), o[P].add(z), o[A].add(z));
    }
    let p = this.groups;
    p.length === 0 && (p = [{
      start: 0,
      count: t.count
    }]);
    for (let M = 0, P = p.length; M < P; ++M) {
      const A = p[M], C = A.start, T = A.count;
      for (let E = C, I = C + T; E < I; E += 3)
        b(
          t.getX(E + 0),
          t.getX(E + 1),
          t.getX(E + 2)
        );
    }
    const w = new S(), x = new S(), g = new S(), B = new S();
    function _(M) {
      g.fromBufferAttribute(s, M), B.copy(g);
      const P = a[M];
      w.copy(P), w.sub(g.multiplyScalar(g.dot(P))).normalize(), x.crossVectors(B, P);
      const C = x.dot(o[M]) < 0 ? -1 : 1;
      r.setXYZW(M, w.x, w.y, w.z, C);
    }
    for (let M = 0, P = p.length; M < P; ++M) {
      const A = p[M], C = A.start, T = A.count;
      for (let E = C, I = C + T; E < I; E += 3)
        _(t.getX(E + 0)), _(t.getX(E + 1)), _(t.getX(E + 2));
    }
    this._transformed = !0;
  }
  /**
   * Computes vertex normals for the given vertex data. For indexed geometries, the method sets
   * each vertex normal to be the average of the face normals of the faces that share that vertex.
   * For non-indexed geometries, vertices are not shared, and the method sets each vertex normal
   * to be the same as the face normal.
   */
  computeVertexNormals() {
    const t = this.index, e = this.getAttribute("position");
    if (e !== void 0) {
      let i = this.getAttribute("normal");
      if (i === void 0 || i.count !== e.count)
        i = new mt(new Float32Array(e.count * 3), 3), this.setAttribute("normal", i);
      else
        for (let u = 0, d = i.count; u < d; u++)
          i.setXYZ(u, 0, 0, 0);
      const s = new S(), n = new S(), r = new S(), a = new S(), o = new S(), c = new S(), h = new S(), l = new S();
      if (t)
        for (let u = 0, d = t.count; u < d; u += 3) {
          const y = t.getX(u + 0), m = t.getX(u + 1), z = t.getX(u + 2);
          s.fromBufferAttribute(e, y), n.fromBufferAttribute(e, m), r.fromBufferAttribute(e, z), h.subVectors(r, n), l.subVectors(s, n), h.cross(l), a.fromBufferAttribute(i, y), o.fromBufferAttribute(i, m), c.fromBufferAttribute(i, z), a.add(h), o.add(h), c.add(h), i.setXYZ(y, a.x, a.y, a.z), i.setXYZ(m, o.x, o.y, o.z), i.setXYZ(z, c.x, c.y, c.z);
        }
      else
        for (let u = 0, d = e.count; u < d; u += 3)
          s.fromBufferAttribute(e, u + 0), n.fromBufferAttribute(e, u + 1), r.fromBufferAttribute(e, u + 2), h.subVectors(r, n), l.subVectors(s, n), h.cross(l), i.setXYZ(u + 0, h.x, h.y, h.z), i.setXYZ(u + 1, h.x, h.y, h.z), i.setXYZ(u + 2, h.x, h.y, h.z);
      this.normalizeNormals(), i.needsUpdate = !0;
    }
  }
  /**
   * Ensures every normal vector in a geometry will have a magnitude of `1`. This will
   * correct lighting on the geometry surfaces.
   */
  normalizeNormals() {
    const t = this.attributes.normal;
    for (let e = 0, i = t.count; e < i; e++)
      X.fromBufferAttribute(t, e), X.normalize(), t.setXYZ(e, X.x, X.y, X.z);
  }
  /**
   * Return a new non-index version of this indexed geometry. If the geometry
   * is already non-indexed, the method is a NOOP.
   *
   * @return {BufferGeometry} The non-indexed version of this indexed geometry.
   */
  toNonIndexed() {
    function t(a, o) {
      const c = a.array, h = a.itemSize, l = a.normalized, u = new c.constructor(o.length * h);
      let d = 0, y = 0;
      for (let m = 0, z = o.length; m < z; m++) {
        a.isInterleavedBufferAttribute ? d = o[m] * a.data.stride + a.offset : d = o[m] * h;
        for (let b = 0; b < h; b++)
          u[y++] = c[d++];
      }
      return new mt(u, h, l);
    }
    if (this.index === null)
      return pt("BufferGeometry.toNonIndexed(): BufferGeometry is already non-indexed."), this;
    const e = new ss(), i = this.index.array, s = this.attributes;
    for (const a in s) {
      const o = s[a], c = t(o, i);
      e.setAttribute(a, c);
    }
    const n = this.morphAttributes;
    for (const a in n) {
      const o = [], c = n[a];
      for (let h = 0, l = c.length; h < l; h++) {
        const u = c[h], d = t(u, i);
        o.push(d);
      }
      e.morphAttributes[a] = o;
    }
    e.morphTargetsRelative = this.morphTargetsRelative;
    const r = this.groups;
    for (let a = 0, o = r.length; a < o; a++) {
      const c = r[a];
      e.addGroup(c.start, c.count, c.materialIndex);
    }
    return e;
  }
  /**
   * Serializes the geometry into JSON.
   *
   * @return {Object} A JSON object representing the serialized geometry.
   */
  toJSON() {
    const t = {
      metadata: {
        version: 4.7,
        type: "BufferGeometry",
        generator: "BufferGeometry.toJSON"
      }
    };
    if (t.uuid = this.uuid, t.type = this.parameters !== void 0 && this._transformed === !0 ? "BufferGeometry" : this.type, t.name = this.name, Object.keys(this.userData).length > 0 && (t.userData = this.userData), this.parameters !== void 0 && this._transformed !== !0) {
      const o = this.parameters;
      for (const c in o)
        o[c] !== void 0 && (t[c] = o[c]);
      return t;
    }
    t.data = { attributes: {} };
    const e = this.index;
    e !== null && (t.data.index = {
      type: e.array.constructor.name,
      array: Array.prototype.slice.call(e.array)
    });
    const i = this.attributes;
    for (const o in i) {
      const c = i[o];
      t.data.attributes[o] = c.toJSON(t.data);
    }
    const s = {};
    let n = !1;
    for (const o in this.morphAttributes) {
      const c = this.morphAttributes[o], h = [];
      for (let l = 0, u = c.length; l < u; l++) {
        const d = c[l];
        h.push(d.toJSON(t.data));
      }
      h.length > 0 && (s[o] = h, n = !0);
    }
    n && (t.data.morphAttributes = s, t.data.morphTargetsRelative = this.morphTargetsRelative);
    const r = this.groups;
    r.length > 0 && (t.data.groups = JSON.parse(JSON.stringify(r)));
    const a = this.boundingSphere;
    return a !== null && (t.data.boundingSphere = a.toJSON()), t;
  }
  /**
   * Returns a new geometry with copied values from this instance.
   *
   * @return {BufferGeometry} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Copies the values of the given geometry to this instance.
   *
   * @param {BufferGeometry} source - The geometry to copy.
   * @return {BufferGeometry} A reference to this instance.
   */
  copy(t) {
    this.index = null, this.attributes = {}, this.morphAttributes = {}, this.groups = [], this.boundingBox = null, this.boundingSphere = null;
    const e = {};
    this.name = t.name;
    const i = t.index;
    i !== null && this.setIndex(i.clone());
    const s = t.attributes;
    for (const c in s) {
      const h = s[c];
      this.setAttribute(c, h.clone(e));
    }
    const n = t.morphAttributes;
    for (const c in n) {
      const h = [], l = n[c];
      for (let u = 0, d = l.length; u < d; u++)
        h.push(l[u].clone(e));
      this.morphAttributes[c] = h;
    }
    this.morphTargetsRelative = t.morphTargetsRelative;
    const r = t.groups;
    for (let c = 0, h = r.length; c < h; c++) {
      const l = r[c];
      this.addGroup(l.start, l.count, l.materialIndex);
    }
    const a = t.boundingBox;
    a !== null && (this.boundingBox = a.clone());
    const o = t.boundingSphere;
    return o !== null && (this.boundingSphere = o.clone()), this.drawRange.start = t.drawRange.start, this.drawRange.count = t.drawRange.count, this.userData = t.userData, this._transformed = t._transformed, this;
  }
  /**
   * Frees the GPU-related resources allocated by this instance. Call this
   * method whenever this instance is no longer used in your app.
   *
   * @fires BufferGeometry#dispose
   */
  dispose() {
    this.dispatchEvent({ type: "dispose" });
  }
}
const Ii = /* @__PURE__ */ new S(), dn = /* @__PURE__ */ new S(), yn = /* @__PURE__ */ new Tt();
class qs {
  /**
   * Constructs a new plane.
   *
   * @param {Vector3} [normal=(1,0,0)] - A unit length vector defining the normal of the plane.
   * @param {number} [constant=0] - The signed distance from the origin to the plane.
   */
  constructor(t = new S(1, 0, 0), e = 0) {
    this.isPlane = !0, this.normal = t, this.constant = e;
  }
  /**
   * Sets the plane components by copying the given values.
   *
   * @param {Vector3} normal - The normal.
   * @param {number} constant - The constant.
   * @return {Plane} A reference to this plane.
   */
  set(t, e) {
    return this.normal.copy(t), this.constant = e, this;
  }
  /**
   * Sets the plane components by defining `x`, `y`, `z` as the
   * plane normal and `w` as the constant.
   *
   * @param {number} x - The value for the normal's x component.
   * @param {number} y - The value for the normal's y component.
   * @param {number} z - The value for the normal's z component.
   * @param {number} w - The constant value.
   * @return {Plane} A reference to this plane.
   */
  setComponents(t, e, i, s) {
    return this.normal.set(t, e, i), this.constant = s, this;
  }
  /**
   * Sets the plane from the given normal and coplanar point (that is a point
   * that lies onto the plane).
   *
   * @param {Vector3} normal - The normal.
   * @param {Vector3} point - A coplanar point.
   * @return {Plane} A reference to this plane.
   */
  setFromNormalAndCoplanarPoint(t, e) {
    return this.normal.copy(t), this.constant = -e.dot(this.normal), this;
  }
  /**
   * Sets the plane from three coplanar points. The winding order is
   * assumed to be counter-clockwise, and determines the direction of
   * the plane normal.
   *
   * @param {Vector3} a - The first coplanar point.
   * @param {Vector3} b - The second coplanar point.
   * @param {Vector3} c - The third coplanar point.
   * @return {Plane} A reference to this plane.
   */
  setFromCoplanarPoints(t, e, i) {
    const s = Ii.subVectors(i, e).cross(dn.subVectors(t, e)).normalize();
    return this.setFromNormalAndCoplanarPoint(s, t), this;
  }
  /**
   * Copies the values of the given plane to this instance.
   *
   * @param {Plane} plane - The plane to copy.
   * @return {Plane} A reference to this plane.
   */
  copy(t) {
    return this.normal.copy(t.normal), this.constant = t.constant, this;
  }
  /**
   * Normalizes the plane normal and adjusts the constant accordingly.
   *
   * @return {Plane} A reference to this plane.
   */
  normalize() {
    const t = 1 / this.normal.length();
    return this.normal.multiplyScalar(t), this.constant *= t, this;
  }
  /**
   * Negates both the plane normal and the constant.
   *
   * @return {Plane} A reference to this plane.
   */
  negate() {
    return this.constant *= -1, this.normal.negate(), this;
  }
  /**
   * Returns the signed distance from the given point to this plane.
   *
   * @param {Vector3} point - The point to compute the distance for.
   * @return {number} The signed distance.
   */
  distanceToPoint(t) {
    return this.normal.dot(t) + this.constant;
  }
  /**
   * Returns the signed distance from the given sphere to this plane.
   *
   * @param {Sphere} sphere - The sphere to compute the distance for.
   * @return {number} The signed distance.
   */
  distanceToSphere(t) {
    return this.distanceToPoint(t.center) - t.radius;
  }
  /**
   * Projects a the given point onto the plane.
   *
   * @param {Vector3} point - The point to project.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The projected point on the plane.
   */
  projectPoint(t, e) {
    return e.copy(t).addScaledVector(this.normal, -this.distanceToPoint(t));
  }
  /**
   * Returns the intersection point of the passed line and the plane. Returns
   * `null` if the line does not intersect. Returns the line's starting point if
   * the line is coplanar with the plane.
   *
   * @param {Line3} line - The line to compute the intersection for.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @param {boolean} [clampToLine=true] - Whether to clamp the intersection to the line segment.
   * @return {?Vector3} The intersection point. Returns `null` if no intersection is detected.
   */
  intersectLine(t, e, i = !0) {
    const s = t.delta(Ii), n = this.normal.dot(s);
    if (n === 0)
      return this.distanceToPoint(t.start) === 0 ? e.copy(t.start) : null;
    const r = -(t.start.dot(this.normal) + this.constant) / n;
    return i === !0 && (r < 0 || r > 1) ? null : e.copy(t.start).addScaledVector(s, r);
  }
  /**
   * Returns `true` if the given line segment intersects with (passes through) the plane.
   *
   * @param {Line3} line - The line to test.
   * @return {boolean} Whether the given line segment intersects with the plane or not.
   */
  intersectsLine(t) {
    const e = this.distanceToPoint(t.start), i = this.distanceToPoint(t.end);
    return e < 0 && i > 0 || i < 0 && e > 0;
  }
  /**
   * Returns `true` if the given bounding box intersects with the plane.
   *
   * @param {Box3} box - The bounding box to test.
   * @return {boolean} Whether the given bounding box intersects with the plane or not.
   */
  intersectsBox(t) {
    return t.intersectsPlane(this);
  }
  /**
   * Returns `true` if the given bounding sphere intersects with the plane.
   *
   * @param {Sphere} sphere - The bounding sphere to test.
   * @return {boolean} Whether the given bounding sphere intersects with the plane or not.
   */
  intersectsSphere(t) {
    return t.intersectsPlane(this);
  }
  /**
   * Returns a coplanar vector to the plane, by calculating the
   * projection of the normal at the origin onto the plane.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The coplanar point.
   */
  coplanarPoint(t) {
    return t.copy(this.normal).multiplyScalar(-this.constant);
  }
  /**
   * Apply a 4x4 matrix to the plane. The matrix must be an affine, homogeneous transform.
   *
   * The optional normal matrix can be pre-computed like so:
   * ```js
   * const optionalNormalMatrix = new THREE.Matrix3().getNormalMatrix( matrix );
   * ```
   *
   * @param {Matrix4} matrix - The transformation matrix.
   * @param {Matrix4} [optionalNormalMatrix] - A pre-computed normal matrix.
   * @return {Plane} A reference to this plane.
   */
  applyMatrix4(t, e) {
    const i = e || yn.getNormalMatrix(t), s = this.coplanarPoint(Ii).applyMatrix4(t), n = this.normal.applyMatrix3(i).normalize();
    return this.constant = -s.dot(n), this;
  }
  /**
   * Translates the plane by the distance defined by the given offset vector.
   * Note that this only affects the plane constant and will not affect the normal vector.
   *
   * @param {Vector3} offset - The offset vector.
   * @return {Plane} A reference to this plane.
   */
  translate(t) {
    return this.constant -= t.dot(this.normal), this;
  }
  /**
   * Returns `true` if this plane is equal with the given one.
   *
   * @param {Plane} plane - The plane to test for equality.
   * @return {boolean} Whether this plane is equal with the given one.
   */
  equals(t) {
    return t.normal.equals(this.normal) && t.constant === this.constant;
  }
  /**
   * Returns a new plane with copied values from this instance.
   *
   * @return {Plane} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
  /**
   * Returns a serialized structure of the plane.
   *
   * @return {Object} Serialized structure with fields representing the object state.
   */
  toJSON() {
    return {
      normal: this.normal.toArray(),
      constant: this.constant
    };
  }
  /**
   * Sets the plane properties from the given JSON.
   *
   * @param {Object} json - The serialized json to set the plane from.
   * @return {Plane} A reference to this plane.
   */
  fromJSON(t) {
    return this.normal.fromArray(t.normal), this.constant = t.constant, this;
  }
}
const _t = /* @__PURE__ */ new S(), Vi = /* @__PURE__ */ new S(), ve = /* @__PURE__ */ new S(), Oe = /* @__PURE__ */ new S();
class mn {
  /**
   * Constructs a new ray.
   *
   * @param {Vector3} [origin=(0,0,0)] - The origin of the ray.
   * @param {Vector3} [direction=(0,0,-1)] - The (normalized) direction of the ray.
   */
  constructor(t = new S(), e = new S(0, 0, -1)) {
    this.origin = t, this.direction = e;
  }
  /**
   * Sets the ray's components by copying the given values.
   *
   * @param {Vector3} origin - The origin.
   * @param {Vector3} direction - The direction.
   * @return {Ray} A reference to this ray.
   */
  set(t, e) {
    return this.origin.copy(t), this.direction.copy(e), this;
  }
  /**
   * Copies the values of the given ray to this instance.
   *
   * @param {Ray} ray - The ray to copy.
   * @return {Ray} A reference to this ray.
   */
  copy(t) {
    return this.origin.copy(t.origin), this.direction.copy(t.direction), this;
  }
  /**
   * Returns a vector that is located at a given distance along this ray.
   *
   * @param {number} t - The distance along the ray to retrieve a position for.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} A position on the ray.
   */
  at(t, e) {
    return e.copy(this.origin).addScaledVector(this.direction, t);
  }
  /**
   * Adjusts the direction of the ray to point at the given vector in world space.
   *
   * @param {Vector3} v - The target position.
   * @return {Ray} A reference to this ray.
   */
  lookAt(t) {
    return this.direction.copy(t).sub(this.origin).normalize(), this;
  }
  /**
   * Shift the origin of this ray along its direction by the given distance.
   *
   * @param {number} t - The distance along the ray to interpolate.
   * @return {Ray} A reference to this ray.
   */
  recast(t) {
    return this.origin.copy(this.at(t, _t)), this;
  }
  /**
   * Returns the point along this ray that is closest to the given point.
   *
   * @param {Vector3} point - A point in 3D space to get the closet location on the ray for.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The closest point on this ray.
   */
  closestPointToPoint(t, e) {
    e.subVectors(t, this.origin);
    const i = e.dot(this.direction);
    return i < 0 ? e.copy(this.origin) : e.copy(this.origin).addScaledVector(this.direction, i);
  }
  /**
   * Returns the distance of the closest approach between this ray and the given point.
   *
   * @param {Vector3} point - A point in 3D space to compute the distance to.
   * @return {number} The distance.
   */
  distanceToPoint(t) {
    return Math.sqrt(this.distanceSqToPoint(t));
  }
  /**
   * Returns the squared distance of the closest approach between this ray and the given point.
   *
   * @param {Vector3} point - A point in 3D space to compute the distance to.
   * @return {number} The squared distance.
   */
  distanceSqToPoint(t) {
    const e = _t.subVectors(t, this.origin).dot(this.direction);
    return e < 0 ? this.origin.distanceToSquared(t) : (_t.copy(this.origin).addScaledVector(this.direction, e), _t.distanceToSquared(t));
  }
  /**
   * Returns the squared distance between this ray and the given line segment.
   *
   * @param {Vector3} v0 - The start point of the line segment.
   * @param {Vector3} v1 - The end point of the line segment.
   * @param {Vector3} [optionalPointOnRay] - When provided, it receives the point on this ray that is closest to the segment.
   * @param {Vector3} [optionalPointOnSegment] - When provided, it receives the point on the line segment that is closest to this ray.
   * @return {number} The squared distance.
   */
  distanceSqToSegment(t, e, i, s) {
    Vi.copy(t).add(e).multiplyScalar(0.5), ve.copy(e).sub(t).normalize(), Oe.copy(this.origin).sub(Vi);
    const n = t.distanceTo(e) * 0.5, r = -this.direction.dot(ve), a = Oe.dot(this.direction), o = -Oe.dot(ve), c = Oe.lengthSq(), h = Math.abs(1 - r * r);
    let l, u, d, y;
    if (h > 0)
      if (l = r * o - a, u = r * a - o, y = n * h, l >= 0)
        if (u >= -y)
          if (u <= y) {
            const m = 1 / h;
            l *= m, u *= m, d = l * (l + r * u + 2 * a) + u * (r * l + u + 2 * o) + c;
          } else
            u = n, l = Math.max(0, -(r * u + a)), d = -l * l + u * (u + 2 * o) + c;
        else
          u = -n, l = Math.max(0, -(r * u + a)), d = -l * l + u * (u + 2 * o) + c;
      else
        u <= -y ? (l = Math.max(0, -(-r * n + a)), u = l > 0 ? -n : Math.min(Math.max(-n, -o), n), d = -l * l + u * (u + 2 * o) + c) : u <= y ? (l = 0, u = Math.min(Math.max(-n, -o), n), d = u * (u + 2 * o) + c) : (l = Math.max(0, -(r * n + a)), u = l > 0 ? n : Math.min(Math.max(-n, -o), n), d = -l * l + u * (u + 2 * o) + c);
    else
      u = r > 0 ? -n : n, l = Math.max(0, -(r * u + a)), d = -l * l + u * (u + 2 * o) + c;
    return i && i.copy(this.origin).addScaledVector(this.direction, l), s && s.copy(Vi).addScaledVector(ve, u), d;
  }
  /**
   * Intersects this ray with the given sphere, returning the intersection
   * point or `null` if there is no intersection.
   *
   * @param {Sphere} sphere - The sphere to intersect.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The intersection point.
   */
  intersectSphere(t, e) {
    if (t.radius < 0) return null;
    _t.subVectors(t.center, this.origin);
    const i = _t.dot(this.direction), s = _t.dot(_t) - i * i, n = t.radius * t.radius;
    if (s > n) return null;
    const r = Math.sqrt(n - s), a = i - r, o = i + r;
    return o < 0 ? null : a < 0 ? this.at(o, e) : this.at(a, e);
  }
  /**
   * Returns `true` if this ray intersects with the given sphere.
   *
   * @param {Sphere} sphere - The sphere to intersect.
   * @return {boolean} Whether this ray intersects with the given sphere or not.
   */
  intersectsSphere(t) {
    return t.radius < 0 ? !1 : this.distanceSqToPoint(t.center) <= t.radius * t.radius;
  }
  /**
   * Computes the distance from the ray's origin to the given plane. Returns `null` if the ray
   * does not intersect with the plane.
   *
   * @param {Plane} plane - The plane to compute the distance to.
   * @return {?number} Whether this ray intersects with the given sphere or not.
   */
  distanceToPlane(t) {
    const e = t.normal.dot(this.direction);
    if (e === 0)
      return t.distanceToPoint(this.origin) === 0 ? 0 : null;
    const i = -(this.origin.dot(t.normal) + t.constant) / e;
    return i >= 0 ? i : null;
  }
  /**
   * Intersects this ray with the given plane, returning the intersection
   * point or `null` if there is no intersection.
   *
   * @param {Plane} plane - The plane to intersect.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The intersection point.
   */
  intersectPlane(t, e) {
    const i = this.distanceToPlane(t);
    return i === null ? null : this.at(i, e);
  }
  /**
   * Returns `true` if this ray intersects with the given plane.
   *
   * @param {Plane} plane - The plane to intersect.
   * @return {boolean} Whether this ray intersects with the given plane or not.
   */
  intersectsPlane(t) {
    const e = t.distanceToPoint(this.origin);
    return e === 0 || t.normal.dot(this.direction) * e < 0;
  }
  /**
   * Intersects this ray with the given bounding box, returning the intersection
   * point or `null` if there is no intersection.
   *
   * @param {Box3} box - The box to intersect.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The intersection point.
   */
  intersectBox(t, e) {
    let i, s, n, r, a, o;
    const c = 1 / this.direction.x, h = 1 / this.direction.y, l = 1 / this.direction.z, u = this.origin;
    return c >= 0 ? (i = (t.min.x - u.x) * c, s = (t.max.x - u.x) * c) : (i = (t.max.x - u.x) * c, s = (t.min.x - u.x) * c), h >= 0 ? (n = (t.min.y - u.y) * h, r = (t.max.y - u.y) * h) : (n = (t.max.y - u.y) * h, r = (t.min.y - u.y) * h), i > r || n > s || ((n > i || isNaN(i)) && (i = n), (r < s || isNaN(s)) && (s = r), l >= 0 ? (a = (t.min.z - u.z) * l, o = (t.max.z - u.z) * l) : (a = (t.max.z - u.z) * l, o = (t.min.z - u.z) * l), i > o || a > s) || ((a > i || i !== i) && (i = a), (o < s || s !== s) && (s = o), s < 0) ? null : this.at(i >= 0 ? i : s, e);
  }
  /**
   * Returns `true` if this ray intersects with the given box.
   *
   * @param {Box3} box - The box to intersect.
   * @return {boolean} Whether this ray intersects with the given box or not.
   */
  intersectsBox(t) {
    return this.intersectBox(t, _t) !== null;
  }
  /**
   * Intersects this ray with the given triangle, returning the intersection
   * point or `null` if there is no intersection.
   *
   * @param {Vector3} a - The first vertex of the triangle.
   * @param {Vector3} b - The second vertex of the triangle.
   * @param {Vector3} c - The third vertex of the triangle.
   * @param {boolean} backfaceCulling - Whether to use backface culling or not.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {?Vector3} The intersection point.
   */
  intersectTriangle(t, e, i, s, n) {
    const r = this.origin, a = this.direction, o = a.x, c = a.y, h = a.z, l = t.x - r.x, u = t.y - r.y, d = t.z - r.z, y = e.x - r.x, m = e.y - r.y, z = e.z - r.z, b = i.x - r.x, p = i.y - r.y, w = i.z - r.z, x = Math.abs(o), g = Math.abs(c), B = Math.abs(h);
    let _, M, P, A, C, T, E, I, V, F, U, K;
    if (x >= g && x >= B ? (P = o, T = l, V = y, K = b, o >= 0 ? (_ = c, M = h, A = u, C = d, E = m, I = z, F = p, U = w) : (_ = h, M = c, A = d, C = u, E = z, I = m, F = w, U = p)) : g >= B ? (P = c, T = u, V = m, K = p, c >= 0 ? (_ = h, M = o, A = d, C = l, E = z, I = y, F = w, U = b) : (_ = o, M = h, A = l, C = d, E = y, I = z, F = b, U = w)) : (P = h, T = d, V = z, K = w, h >= 0 ? (_ = o, M = c, A = l, C = u, E = y, I = m, F = b, U = p) : (_ = c, M = o, A = u, C = l, E = m, I = y, F = p, U = b)), P === 0) return null;
    const ct = _ / P, st = M / P, yt = 1 / P, Zt = A - ct * T, me = C - st * T, di = E - ct * V, xt = I - st * V, Fe = F - ct * K, ke = U - st * K, Ut = Fe * xt - ke * di, Nt = Zt * ke - me * Fe, Lt = di * me - xt * Zt;
    if (s) {
      if (Ut < 0 || Nt < 0 || Lt < 0) return null;
    } else if ((Ut < 0 || Nt < 0 || Lt < 0) && (Ut > 0 || Nt > 0 || Lt > 0)) return null;
    const pe = Ut + Nt + Lt;
    if (pe === 0) return null;
    const Dt = yt * (Ut * T + Nt * V + Lt * K);
    return (pe > 0 ? Dt < 0 : Dt > 0) ? null : this.at(Dt / pe, n);
  }
  /**
   * Transforms this ray with the given 4x4 transformation matrix.
   *
   * @param {Matrix4} matrix4 - The transformation matrix.
   * @return {Ray} A reference to this ray.
   */
  applyMatrix4(t) {
    return this.origin.applyMatrix4(t), this.direction.transformDirection(t), this;
  }
  /**
   * Returns `true` if this ray is equal with the given one.
   *
   * @param {Ray} ray - The ray to test for equality.
   * @return {boolean} Whether this ray is equal with the given one.
   */
  equals(t) {
    return t.origin.equals(this.origin) && t.direction.equals(this.direction);
  }
  /**
   * Returns a new ray with copied values from this instance.
   *
   * @return {Ray} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
}
class vs {
  static {
    vs.prototype.isMatrix2 = !0;
  }
  /**
   * Constructs a new 2x2 matrix. The arguments are supposed to be
   * in row-major order. If no arguments are provided, the constructor
   * initializes the matrix as an identity matrix.
   *
   * @param {number} [n11] - 1-1 matrix element.
   * @param {number} [n12] - 1-2 matrix element.
   * @param {number} [n21] - 2-1 matrix element.
   * @param {number} [n22] - 2-2 matrix element.
   */
  constructor(t, e, i, s) {
    this.elements = [
      1,
      0,
      0,
      1
    ], t !== void 0 && this.set(t, e, i, s);
  }
  /**
   * Sets this matrix to the 2x2 identity matrix.
   *
   * @return {Matrix2} A reference to this matrix.
   */
  identity() {
    return this.set(
      1,
      0,
      0,
      1
    ), this;
  }
  /**
   * Sets the elements of the matrix from the given array.
   *
   * @param {Array<number>} array - The matrix elements in column-major order.
   * @param {number} [offset=0] - Index of the first element in the array.
   * @return {Matrix2} A reference to this matrix.
   */
  fromArray(t, e = 0) {
    for (let i = 0; i < 4; i++)
      this.elements[i] = t[i + e];
    return this;
  }
  /**
   * Sets the elements of the matrix.The arguments are supposed to be
   * in row-major order.
   *
   * @param {number} n11 - 1-1 matrix element.
   * @param {number} n12 - 1-2 matrix element.
   * @param {number} n21 - 2-1 matrix element.
   * @param {number} n22 - 2-2 matrix element.
   * @return {Matrix2} A reference to this matrix.
   */
  set(t, e, i, s) {
    const n = this.elements;
    return n[0] = t, n[2] = e, n[1] = i, n[3] = s, this;
  }
}
const bs = /* @__PURE__ */ new S(), We = /* @__PURE__ */ new S(), ne = /* @__PURE__ */ new S(), re = /* @__PURE__ */ new S(), Fi = /* @__PURE__ */ new S(), pn = /* @__PURE__ */ new S(), xn = /* @__PURE__ */ new S();
class St {
  /**
   * Constructs a new line segment.
   *
   * @param {Vector3} [start=(0,0,0)] - Start of the line segment.
   * @param {Vector3} [end=(0,0,0)] - End of the line segment.
   */
  constructor(t = new S(), e = new S()) {
    this.start = t, this.end = e;
  }
  /**
   * Sets the start and end values by copying the given vectors.
   *
   * @param {Vector3} start - The start point.
   * @param {Vector3} end - The end point.
   * @return {Line3} A reference to this line segment.
   */
  set(t, e) {
    return this.start.copy(t), this.end.copy(e), this;
  }
  /**
   * Copies the values of the given line segment to this instance.
   *
   * @param {Line3} line - The line segment to copy.
   * @return {Line3} A reference to this line segment.
   */
  copy(t) {
    return this.start.copy(t.start), this.end.copy(t.end), this;
  }
  /**
   * Returns the center of the line segment.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The center point.
   */
  getCenter(t) {
    return t.addVectors(this.start, this.end).multiplyScalar(0.5);
  }
  /**
   * Returns the delta vector of the line segment's start and end point.
   *
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The delta vector.
   */
  delta(t) {
    return t.subVectors(this.end, this.start);
  }
  /**
   * Returns the squared Euclidean distance between the line' start and end point.
   *
   * @return {number} The squared Euclidean distance.
   */
  distanceSq() {
    return this.start.distanceToSquared(this.end);
  }
  /**
   * Returns the Euclidean distance between the line' start and end point.
   *
   * @return {number} The Euclidean distance.
   */
  distance() {
    return this.start.distanceTo(this.end);
  }
  /**
   * Returns a vector at a certain position along the line segment.
   *
   * @param {number} t - A value between `[0,1]` to represent a position along the line segment.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The delta vector.
   */
  at(t, e) {
    return this.delta(e).multiplyScalar(t).add(this.start);
  }
  /**
   * Returns a point parameter based on the closest point as projected on the line segment.
   *
   * @param {Vector3} point - The point for which to return a point parameter.
   * @param {boolean} clampToLine - Whether to clamp the result to the range `[0,1]` or not.
   * @return {number} The point parameter.
   */
  closestPointToPointParameter(t, e) {
    bs.subVectors(t, this.start), We.subVectors(this.end, this.start);
    const i = We.dot(We);
    if (i === 0) return 0;
    let n = We.dot(bs) / i;
    return e && (n = k(n, 0, 1)), n;
  }
  /**
   * Returns the closest point on the line for a given point.
   *
   * @param {Vector3} point - The point to compute the closest point on the line for.
   * @param {boolean} clampToLine - Whether to clamp the result to the range `[0,1]` or not.
   * @param {Vector3} target - The target vector that is used to store the method's result.
   * @return {Vector3} The closest point on the line.
   */
  closestPointToPoint(t, e, i) {
    const s = this.closestPointToPointParameter(t, e);
    return this.delta(i).multiplyScalar(s).add(this.start);
  }
  /**
   * Returns the closest squared distance between this line segment and the given one.
   *
   * @param {Line3} line - The line segment to compute the closest squared distance to.
   * @param {Vector3} [c1] - The closest point on this line segment.
   * @param {Vector3} [c2] - The closest point on the given line segment.
   * @return {number} The squared distance between this line segment and the given one.
   */
  distanceSqToLine3(t, e = pn, i = xn) {
    const s = 10000000000000001e-32;
    let n, r;
    const a = this.start, o = t.start, c = this.end, h = t.end;
    ne.subVectors(c, a), re.subVectors(h, o), Fi.subVectors(a, o);
    const l = ne.dot(ne), u = re.dot(re), d = re.dot(Fi);
    if (l <= s && u <= s)
      return e.copy(a), i.copy(o), e.sub(i), e.dot(e);
    if (l <= s)
      n = 0, r = d / u, r = k(r, 0, 1);
    else {
      const y = ne.dot(Fi);
      if (u <= s)
        r = 0, n = k(-y / l, 0, 1);
      else {
        const m = ne.dot(re), z = l * u - m * m;
        z !== 0 ? n = k((m * d - y * u) / z, 0, 1) : n = 0, r = (m * n + d) / u, r < 0 ? (r = 0, n = k(-y / l, 0, 1)) : r > 1 && (r = 1, n = k((m - y) / l, 0, 1));
      }
    }
    return e.copy(a).addScaledVector(ne, n), i.copy(o).addScaledVector(re, r), e.distanceToSquared(i);
  }
  /**
   * Applies a 4x4 transformation matrix to this line segment.
   *
   * @param {Matrix4} matrix - The transformation matrix.
   * @return {Line3} A reference to this line segment.
   */
  applyMatrix4(t) {
    return this.start.applyMatrix4(t), this.end.applyMatrix4(t), this;
  }
  /**
   * Returns `true` if this line segment is equal with the given one.
   *
   * @param {Line3} line - The line segment to test for equality.
   * @return {boolean} Whether this line segment is equal with the given one.
   */
  equals(t) {
    return t.start.equals(this.start) && t.end.equals(this.end);
  }
  /**
   * Returns a new line segment with copied values from this instance.
   *
   * @return {Line3} A clone of this instance.
   */
  clone() {
    return new this.constructor().copy(this);
  }
}
typeof __THREE_DEVTOOLS__ < "u" && __THREE_DEVTOOLS__.dispatchEvent(new CustomEvent("register", { detail: {
  revision: "186"
} }));
typeof window < "u" && (window.__THREE__ ? pt("WARNING: Multiple instances of Three.js being imported.") : window.__THREE__ = "186");
const gn = /* @__PURE__ */ new Tt();
gn.set(-1, 0, 0, 0, 1, 0, 0, 0, 1);
const wn = /* @__PURE__ */ new Tt();
wn.set(-1, 0, 0, 0, 1, 0, 0, 0, 1);
const Os = 0, bn = 1, zn = 2, zs = 2, ki = 1.25, _s = 1, J = 32, v = J / 4, Ws = 65535, ri = Math.pow(2, -24), ns = Symbol("SKIP_GENERATION"), Xs = {
  strategy: Os,
  maxDepth: 40,
  targetLeafSize: 10,
  useSharedArrayBuffer: !1,
  setBoundingBox: !0,
  onProgress: null,
  indirect: !1,
  verbose: !0,
  range: null,
  [ns]: !1
};
function N(f, t, e) {
  return e.min.x = t[f], e.min.y = t[f + 1], e.min.z = t[f + 2], e.max.x = t[f + 3], e.max.y = t[f + 4], e.max.z = t[f + 5], e;
}
function Hi(f) {
  let t = -1, e = -1 / 0;
  for (let i = 0; i < 3; i++) {
    const s = f[i + 3] - f[i];
    s > e && (e = s, t = i);
  }
  return t;
}
function Ms(f, t) {
  t.set(f);
}
function As(f, t, e) {
  let i, s;
  for (let n = 0; n < 3; n++) {
    const r = n + 3;
    i = f[n], s = t[n], e[n] = i < s ? i : s, i = f[r], s = t[r], e[r] = i > s ? i : s;
  }
}
function Xe(f, t, e) {
  for (let i = 0; i < 3; i++) {
    const s = t[f + 2 * i], n = t[f + 2 * i + 1], r = s - n, a = s + n;
    r < e[i] && (e[i] = r), a > e[i + 3] && (e[i + 3] = a);
  }
}
function _e(f) {
  const t = f[3] - f[0], e = f[4] - f[1], i = f[5] - f[2];
  return 2 * (t * e + e * i + i * t);
}
function L(f, t) {
  return t[f + 15] === Ws;
}
function Y(f, t) {
  return t[f + 6];
}
function G(f, t) {
  return t[f + 14];
}
function O(f) {
  return f + v;
}
function W(f, t) {
  const e = t[f + 6];
  return f + e * v;
}
function rs(f, t) {
  return t[f + 7];
}
function Ri(f, t, e, i, s) {
  let n = 1 / 0, r = 1 / 0, a = 1 / 0, o = -1 / 0, c = -1 / 0, h = -1 / 0, l = 1 / 0, u = 1 / 0, d = 1 / 0, y = -1 / 0, m = -1 / 0, z = -1 / 0;
  const b = f.offset || 0;
  for (let p = (t - b) * 6, w = (t + e - b) * 6; p < w; p += 6) {
    const x = f[p + 0], g = f[p + 1], B = x - g, _ = x + g;
    B < n && (n = B), _ > o && (o = _), x < l && (l = x), x > y && (y = x);
    const M = f[p + 2], P = f[p + 3], A = M - P, C = M + P;
    A < r && (r = A), C > c && (c = C), M < u && (u = M), M > m && (m = M);
    const T = f[p + 4], E = f[p + 5], I = T - E, V = T + E;
    I < a && (a = I), V > h && (h = V), T < d && (d = T), T > z && (z = T);
  }
  i[0] = n, i[1] = r, i[2] = a, i[3] = o, i[4] = c, i[5] = h, s[0] = l, s[1] = u, s[2] = d, s[3] = y, s[4] = m, s[5] = z;
}
const Mt = 32, _n = (f, t) => f.candidate - t.candidate, It = /* @__PURE__ */ new Array(Mt).fill().map(() => ({
  count: 0,
  bounds: new Float32Array(6),
  rightCacheBounds: new Float32Array(6),
  leftCacheBounds: new Float32Array(6),
  candidate: 0
})), Ye = /* @__PURE__ */ new Float32Array(6);
function Mn(f, t, e, i, s, n) {
  let r = -1, a = 0;
  if (n === Os)
    r = Hi(t), r !== -1 && (a = (t[r] + t[r + 3]) / 2);
  else if (n === bn)
    r = Hi(f), r !== -1 && (a = An(e, i, s, r));
  else if (n === zn) {
    const o = _e(f);
    let c = ki * s;
    const h = e.offset || 0, l = (i - h) * 6, u = (i + s - h) * 6;
    for (let d = 0; d < 3; d++) {
      const y = t[d], b = (t[d + 3] - y) / Mt;
      if (s < Mt / 4) {
        const p = [...It];
        p.length = s;
        let w = 0;
        for (let g = l; g < u; g += 6, w++) {
          const B = p[w];
          B.candidate = e[g + 2 * d], B.count = 0;
          const {
            bounds: _,
            leftCacheBounds: M,
            rightCacheBounds: P
          } = B;
          for (let A = 0; A < 3; A++)
            P[A] = 1 / 0, P[A + 3] = -1 / 0, M[A] = 1 / 0, M[A + 3] = -1 / 0, _[A] = 1 / 0, _[A + 3] = -1 / 0;
          Xe(g, e, _);
        }
        p.sort(_n);
        let x = s;
        for (let g = 0; g < x; g++) {
          const B = p[g];
          for (; g + 1 < x && p[g + 1].candidate === B.candidate; )
            p.splice(g + 1, 1), x--;
        }
        for (let g = l; g < u; g += 6) {
          const B = e[g + 2 * d];
          for (let _ = 0; _ < x; _++) {
            const M = p[_];
            B >= M.candidate ? Xe(g, e, M.rightCacheBounds) : (Xe(g, e, M.leftCacheBounds), M.count++);
          }
        }
        for (let g = 0; g < x; g++) {
          const B = p[g], _ = B.count, M = s - B.count, P = B.leftCacheBounds, A = B.rightCacheBounds;
          let C = 0;
          _ !== 0 && (C = _e(P) / o);
          let T = 0;
          M !== 0 && (T = _e(A) / o);
          const E = _s + ki * (C * _ + T * M);
          E < c && (r = d, c = E, a = B.candidate);
        }
      } else {
        for (let x = 0; x < Mt; x++) {
          const g = It[x];
          g.count = 0, g.candidate = y + b + x * b;
          const B = g.bounds;
          for (let _ = 0; _ < 3; _++)
            B[_] = 1 / 0, B[_ + 3] = -1 / 0;
        }
        for (let x = l; x < u; x += 6) {
          let _ = ~~((e[x + 2 * d] - y) / b);
          _ >= Mt && (_ = Mt - 1);
          const M = It[_];
          M.count++, Xe(x, e, M.bounds);
        }
        const p = It[Mt - 1];
        Ms(p.bounds, p.rightCacheBounds);
        for (let x = Mt - 2; x >= 0; x--) {
          const g = It[x], B = It[x + 1];
          As(g.bounds, B.rightCacheBounds, g.rightCacheBounds);
        }
        let w = 0;
        for (let x = 0; x < Mt - 1; x++) {
          const g = It[x], B = g.count, _ = g.bounds, P = It[x + 1].rightCacheBounds;
          B !== 0 && (w === 0 ? Ms(_, Ye) : As(_, Ye, Ye)), w += B;
          let A = 0, C = 0;
          w !== 0 && (A = _e(Ye) / o);
          const T = s - w;
          T !== 0 && (C = _e(P) / o);
          const E = _s + ki * (A * w + C * T);
          E < c && (r = d, c = E, a = g.candidate);
        }
      }
    }
  } else
    console.warn(`BVH: Invalid build strategy value ${n} used.`);
  return { axis: r, pos: a };
}
function An(f, t, e, i) {
  let s = 0;
  const n = f.offset;
  for (let r = t, a = t + e; r < a; r++)
    s += f[(r - n) * 6 + i * 2];
  return s / e;
}
class Ui {
  constructor() {
    this.boundingData = new Float32Array(6);
  }
}
function Sn(f, t, e, i, s, n) {
  let r = i, a = i + s - 1;
  const o = n.pos, c = n.axis * 2, h = e.offset || 0;
  for (; ; ) {
    for (; r <= a && e[(r - h) * 6 + c] < o; )
      r++;
    for (; r <= a && e[(a - h) * 6 + c] >= o; )
      a--;
    if (r < a) {
      for (let l = 0; l < t; l++) {
        let u = f[r * t + l];
        f[r * t + l] = f[a * t + l], f[a * t + l] = u;
      }
      for (let l = 0; l < 6; l++) {
        const u = r - h, d = a - h, y = e[u * 6 + l];
        e[u * 6 + l] = e[d * 6 + l], e[d * 6 + l] = y;
      }
      r++, a--;
    } else
      return r;
  }
}
let Ys, oi, Zi, Hs;
const Bn = Math.pow(2, 32);
function $i(f) {
  return "count" in f ? 1 : 1 + $i(f.left) + $i(f.right);
}
function Tn(f, t, e) {
  return Ys = new Float32Array(e), oi = new Uint32Array(e), Zi = new Uint16Array(e), Hs = new Uint8Array(e), Ji(f, t);
}
function Ji(f, t) {
  const e = f / 4, i = f / 2, s = "count" in t, n = t.boundingData;
  for (let r = 0; r < 6; r++)
    Ys[e + r] = n[r];
  if (s)
    return t.buffer ? (Hs.set(new Uint8Array(t.buffer), f), f + t.buffer.byteLength) : (oi[e + 6] = t.offset, Zi[i + 14] = t.count, Zi[i + 15] = Ws, f + J);
  {
    const { left: r, right: a, splitAxis: o } = t, c = f + J;
    let h = Ji(c, r);
    const l = f / J, d = h / J - l;
    if (d > Bn)
      throw new Error("MeshBVH: Cannot store relative child node offset greater than 32 bits.");
    return oi[e + 6] = d, oi[e + 7] = o, Ji(h, a);
  }
}
function Pn(f, t, e, i, s, n) {
  const {
    maxDepth: r,
    verbose: a,
    targetLeafSize: o,
    _strictLeafSize: c = 1 / 0,
    strategy: h,
    onProgress: l
  } = s, u = f.primitiveBuffer, d = f.primitiveBufferStride, y = new Float32Array(6);
  let m = !1;
  const z = new Ui();
  return Ri(t, e, i, z.boundingData, y), p(z, e, i, y), z;
  function b(w) {
    l && l((w - n.offset) / n.count);
  }
  function p(w, x, g, B = null, _ = 0) {
    !m && _ >= r && (m = !0, a && console.warn(`BVH: Max depth of ${r} reached when generating BVH. Consider increasing maxDepth.`));
    const M = g > c;
    if (g <= o && !M || _ >= r)
      return b(x + g), w.offset = x, w.count = g, w;
    const P = Mn(w.boundingData, B, t, x, g, h);
    let A = P.axis === -1 ? -1 : Sn(u, d, t, x, g, P);
    if (P.axis === -1 || A === x || A === x + g) {
      if (!M)
        return b(x + g), w.offset = x, w.count = g, w;
      P.axis = Math.max(0, Hi(w.boundingData)), A = x + Math.max(1, Math.floor(g / 2));
    }
    w.splitAxis = P.axis;
    const C = new Ui(), T = x, E = A - x;
    w.left = C, Ri(t, T, E, C.boundingData, y), p(C, T, E, y, _ + 1);
    const I = new Ui(), V = A, F = g - E;
    return w.right = I, Ri(t, V, F, I.boundingData, y), p(I, V, F, y, _ + 1), w;
  }
}
function Cn(f, t) {
  const e = t.useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer, i = f.getRootRanges(t.range), s = i[0], n = i[i.length - 1], r = {
    offset: s.offset,
    count: n.offset + n.count - s.offset
  }, a = new Float32Array(6 * r.count);
  a.offset = r.offset, f.computePrimitiveBounds(r.offset, r.count, a), f._roots = i.map((o) => {
    const c = Pn(f, a, o.offset, o.count, t, r), h = $i(c), l = new e(J * h);
    return Tn(0, c, l), l;
  });
}
class os {
  constructor(t) {
    this._getNewPrimitive = t, this._primitives = [];
  }
  getPrimitive() {
    const t = this._primitives;
    return t.length === 0 ? this._getNewPrimitive() : t.pop();
  }
  releasePrimitive(t) {
    this._primitives.push(t);
  }
}
class En {
  constructor() {
    this.float32Array = null, this.uint16Array = null, this.uint32Array = null;
    const t = [];
    let e = null;
    this.setBuffer = (i) => {
      e && t.push(e), e = i, this.float32Array = new Float32Array(i), this.uint16Array = new Uint16Array(i), this.uint32Array = new Uint32Array(i);
    }, this.clearBuffer = () => {
      e = null, this.float32Array = null, this.uint16Array = null, this.uint32Array = null, t.length !== 0 && this.setBuffer(t.pop());
    };
  }
}
const R = /* @__PURE__ */ new En();
let Ft, ye;
const oe = [], He = /* @__PURE__ */ new os(() => new Q());
function In(f, t, e, i, s, n) {
  Ft = He.getPrimitive(), ye = He.getPrimitive(), oe.push(Ft, ye), R.setBuffer(f._roots[t]);
  const r = Gi(0, f.geometry, e, i, s, n);
  R.clearBuffer(), He.releasePrimitive(Ft), He.releasePrimitive(ye), oe.pop(), oe.pop();
  const a = oe.length;
  return a > 0 && (ye = oe[a - 1], Ft = oe[a - 2]), r;
}
function Gi(f, t, e, i, s = null, n = 0, r = 0) {
  const { float32Array: a, uint16Array: o, uint32Array: c } = R;
  let h = f * 2;
  if (L(h, o)) {
    const y = Y(f, c), m = G(h, o);
    return N(f, a, Ft), i(y, m, !1, r, n + f / v, Ft);
  } else {
    let T = function(I) {
      const { uint16Array: V, uint32Array: F } = R;
      let U = I * 2;
      for (; !L(U, V); )
        I = O(I), U = I * 2;
      return Y(I, F);
    }, E = function(I) {
      const { uint16Array: V, uint32Array: F } = R;
      let U = I * 2;
      for (; !L(U, V); )
        I = W(I, F), U = I * 2;
      return Y(I, F) + G(U, V);
    };
    var u = T, d = E;
    const y = O(f), m = W(f, c);
    let z = y, b = m, p, w, x, g;
    if (s && (x = Ft, g = ye, N(z, a, x), N(b, a, g), p = s(x), w = s(g), w < p)) {
      z = m, b = y;
      const I = p;
      p = w, w = I, x = g;
    }
    x || (x = Ft, N(z, a, x));
    const B = L(z * 2, o), _ = e(x, B, p, r + 1, n + z / v);
    let M;
    if (_ === zs) {
      const I = T(z), F = E(z) - I;
      M = i(I, F, !0, r + 1, n + z / v, x);
    } else
      M = _ && Gi(
        z,
        t,
        e,
        i,
        s,
        n,
        r + 1
      );
    if (M) return !0;
    g = ye, N(b, a, g);
    const P = L(b * 2, o), A = e(g, P, w, r + 1, n + b / v);
    let C;
    if (A === zs) {
      const I = T(b), F = E(b) - I;
      C = i(I, F, !0, r + 1, n + b / v, g);
    } else
      C = A && Gi(
        b,
        t,
        e,
        i,
        s,
        n,
        r + 1
      );
    return !!C;
  }
}
const Ce = /* @__PURE__ */ new R.constructor(), ai = /* @__PURE__ */ new R.constructor(), Vt = /* @__PURE__ */ new os(() => new Q()), ae = /* @__PURE__ */ new Q(), ce = /* @__PURE__ */ new Q(), Ni = /* @__PURE__ */ new Q(), Li = /* @__PURE__ */ new Q();
let Di = !1;
function Vn(f, t, e, i) {
  if (Di)
    throw new Error("MeshBVH: Recursive calls to bvhcast not supported.");
  Di = !0;
  const s = f._roots, n = t._roots;
  let r, a = 0, o = 0;
  const c = new H().copy(e).invert();
  for (let h = 0, l = s.length; h < l; h++) {
    Ce.setBuffer(s[h]), o = 0;
    const u = Vt.getPrimitive();
    N(0, Ce.float32Array, u), u.applyMatrix4(c);
    for (let d = 0, y = n.length; d < y && (ai.setBuffer(n[d]), r = ft(
      0,
      0,
      e,
      c,
      i,
      a,
      o,
      0,
      0,
      u
    ), ai.clearBuffer(), o += n[d].byteLength / J, !r); d++)
      ;
    if (Vt.releasePrimitive(u), Ce.clearBuffer(), a += s[h].byteLength / J, r)
      break;
  }
  return Di = !1, r;
}
function ft(f, t, e, i, s, n = 0, r = 0, a = 0, o = 0, c = null, h = !1) {
  let l, u;
  h ? (l = ai, u = Ce) : (l = Ce, u = ai);
  const d = l.float32Array, y = l.uint32Array, m = l.uint16Array, z = u.float32Array, b = u.uint32Array, p = u.uint16Array, w = f * 2, x = t * 2, g = L(w, m), B = L(x, p);
  let _ = !1;
  if (B && g)
    h ? _ = s(
      Y(t, b),
      G(t * 2, p),
      Y(f, y),
      G(f * 2, m),
      o,
      r + t / v,
      a,
      n + f / v
    ) : _ = s(
      Y(f, y),
      G(f * 2, m),
      Y(t, b),
      G(t * 2, p),
      a,
      n + f / v,
      o,
      r + t / v
    );
  else if (B) {
    const M = Vt.getPrimitive();
    N(t, z, M), M.applyMatrix4(e);
    const P = O(f), A = W(f, y);
    N(P, d, ae), N(A, d, ce);
    const C = M.intersectsBox(ae), T = M.intersectsBox(ce);
    _ = C && ft(
      t,
      P,
      i,
      e,
      s,
      r,
      n,
      o,
      a + 1,
      M,
      !h
    ) || T && ft(
      t,
      A,
      i,
      e,
      s,
      r,
      n,
      o,
      a + 1,
      M,
      !h
    ), Vt.releasePrimitive(M);
  } else {
    const M = O(t), P = W(t, b);
    N(M, z, Ni), N(P, z, Li);
    const A = c.intersectsBox(Ni), C = c.intersectsBox(Li);
    if (A && C)
      _ = ft(
        f,
        M,
        e,
        i,
        s,
        n,
        r,
        a,
        o + 1,
        c,
        h
      ) || ft(
        f,
        P,
        e,
        i,
        s,
        n,
        r,
        a,
        o + 1,
        c,
        h
      );
    else if (A)
      if (g)
        _ = ft(
          f,
          M,
          e,
          i,
          s,
          n,
          r,
          a,
          o + 1,
          c,
          h
        );
      else {
        const T = Vt.getPrimitive();
        T.copy(Ni).applyMatrix4(e);
        const E = O(f), I = W(f, y);
        N(E, d, ae), N(I, d, ce);
        const V = T.intersectsBox(ae), F = T.intersectsBox(ce);
        _ = V && ft(
          M,
          E,
          i,
          e,
          s,
          r,
          n,
          o,
          a + 1,
          T,
          !h
        ) || F && ft(
          M,
          I,
          i,
          e,
          s,
          r,
          n,
          o,
          a + 1,
          T,
          !h
        ), Vt.releasePrimitive(T);
      }
    else if (C)
      if (g)
        _ = ft(
          f,
          P,
          e,
          i,
          s,
          n,
          r,
          a,
          o + 1,
          c,
          h
        );
      else {
        const T = Vt.getPrimitive();
        T.copy(Li).applyMatrix4(e);
        const E = O(f), I = W(f, y);
        N(E, d, ae), N(I, d, ce);
        const V = T.intersectsBox(ae), F = T.intersectsBox(ce);
        _ = V && ft(
          P,
          E,
          i,
          e,
          s,
          r,
          n,
          o,
          a + 1,
          T,
          !h
        ) || F && ft(
          P,
          I,
          i,
          e,
          s,
          r,
          n,
          o,
          a + 1,
          T,
          !h
        ), Vt.releasePrimitive(T);
      }
  }
  return _;
}
const qi = new class {
  constructor() {
    let f = null, t = null, e = null, i = !1;
    this.root = null, this.buffer = null, this.uint32Array = null, this.uint16Array = null, this.setBVH = (n, r) => {
      if (i)
        throw new Error("BVHTraversalHelper: cannot call setBVH during an active traversal.");
      this.root = r, this.buffer = f = n._roots[r], this.uint16Array = e = new Uint16Array(f), this.uint32Array = t = new Uint32Array(f);
    }, this.reset = () => {
      this.root = null, this.buffer = f = null, this.uint16Array = e = null, this.uint32Array = t = null;
    }, this.getRangeStart = (n) => {
      let r = n * 2;
      for (; !L(r, e); )
        n = O(n), r = n * 2;
      return Y(n, t);
    }, this.getRangeEnd = (n) => {
      let r = n * 2;
      for (; !L(r, e); )
        n = W(n, t), r = n * 2;
      return Y(n, t) + G(r, e);
    };
    const s = (n, r, a) => {
      const o = r * 2, c = L(o, e);
      if (!n(a, c, r) && !c) {
        const l = O(r), u = W(r, t);
        s(n, l, a + 1), s(n, u, a + 1);
      }
    };
    this.traverseBuffer = (n) => {
      if (i)
        throw new Error("BVHTraversalHelper: cannot start a traversal during an active traversal.");
      i = !0;
      try {
        s(n, 0, 0);
      } finally {
        i = !1;
      }
    }, this.traverse = (n) => {
      this.traverseBuffer((r, a, o) => {
        if (a) {
          const c = o * 2, h = t[o + 6], l = e[c + 14];
          return n(r, a, new Float32Array(f, o * 4, 6), h, l);
        } else {
          const c = rs(o, t);
          return n(r, a, new Float32Array(f, o * 4, 6), c);
        }
      });
    };
  }
}(), Ss = /* @__PURE__ */ new Q(), he = /* @__PURE__ */ new Float32Array(6);
class Fn {
  constructor() {
    this._roots = null, this.primitiveBuffer = null, this.primitiveBufferStride = null;
  }
  init(t) {
    t = {
      ...Xs,
      ...t
    }, "maxLeafSize" in t && (console.warn('BVH: "maxLeafSize" option has been deprecated. Use "targetLeafSize", instead.'), t = {
      ...t,
      targetLeafSize: t.maxLeafSize
    }), Cn(this, t);
  }
  getRootRanges() {
    throw new Error("BVH: getRootRanges() not implemented");
  }
  // write the i-th primitive bounds in a 6-value min / max format to the buffer
  // starting at the given "writeOffset"
  writePrimitiveBounds() {
    throw new Error("BVH: writePrimitiveBounds() not implemented");
  }
  // writes the union bounds of all primitives in the given range in a min / max format
  // to the buffer
  writePrimitiveRangeBounds(t, e, i, s) {
    let n = 1 / 0, r = 1 / 0, a = 1 / 0, o = -1 / 0, c = -1 / 0, h = -1 / 0;
    for (let l = t, u = t + e; l < u; l++) {
      this.writePrimitiveBounds(l, he, 0);
      const [d, y, m, z, b, p] = he;
      d < n && (n = d), z > o && (o = z), y < r && (r = y), b > c && (c = b), m < a && (a = m), p > h && (h = p);
    }
    return i[s + 0] = n, i[s + 1] = r, i[s + 2] = a, i[s + 3] = o, i[s + 4] = c, i[s + 5] = h, i;
  }
  computePrimitiveBounds(t, e, i) {
    const s = i.offset || 0;
    for (let n = t, r = t + e; n < r; n++) {
      this.writePrimitiveBounds(n, he, 0);
      const [a, o, c, h, l, u] = he, d = (a + h) / 2, y = (o + l) / 2, m = (c + u) / 2, z = (h - a) / 2, b = (l - o) / 2, p = (u - c) / 2, w = (n - s) * 6;
      i[w + 0] = d, i[w + 1] = z + (Math.abs(d) + z) * ri, i[w + 2] = y, i[w + 3] = b + (Math.abs(y) + b) * ri, i[w + 4] = m, i[w + 5] = p + (Math.abs(m) + p) * ri;
    }
    return i;
  }
  /**
   * Adjusts all primitive offsets stored in the BVH leaf nodes by the given value. Useful when
   * geometry buffers have been shifted or compacted (e.g. when merging geometries).
   * @param {number} offset
   */
  shiftPrimitiveOffsets(t) {
    const e = this._indirectBuffer;
    if (e)
      for (let i = 0, s = e.length; i < s; i++)
        e[i] += t;
    else {
      const i = this._roots;
      for (let s = 0; s < i.length; s++) {
        const n = i[s], r = new Uint32Array(n), a = new Uint16Array(n), o = n.byteLength / J;
        for (let c = 0; c < o; c++) {
          const h = v * c, l = 2 * h;
          L(l, a) && (r[h + 6] += t);
        }
      }
    }
  }
  /**
   * Traverses all nodes of the BVH, invoking a callback for each node.
   *
   * For leaf nodes the callback receives `( depth, isLeaf, boundingData, offset, count )`.
   * For internal nodes it receives `( depth, isLeaf, boundingData, splitAxis )` and may
   * return `true` to stop descending into that node's children.
   *
   * @param {Function} callback
   * @param {number} [rootIndex=0]
   */
  traverse(t, e = 0) {
    qi.setBVH(this, e), qi.traverse(t), qi.reset();
  }
  /**
   * Refits all BVH node bounds to reflect the current primitive positions. Faster than
   * rebuilding the BVH but produces a less optimal tree after large vertex deformations.
   */
  refit() {
    const t = this._roots;
    for (let e = 0, i = t.length; e < i; e++) {
      const s = t[e], n = new Uint32Array(s), r = new Uint16Array(s), a = new Float32Array(s), o = s.byteLength / J;
      for (let c = o - 1; c >= 0; c--) {
        const h = c * v, l = h * 2;
        if (L(l, r)) {
          const d = Y(h, n), y = G(l, r);
          this.writePrimitiveRangeBounds(d, y, he, 0), a.set(he, h);
        } else {
          const d = O(h), y = W(h, n);
          for (let m = 0; m < 3; m++) {
            const z = a[d + m], b = a[d + m + 3], p = a[y + m], w = a[y + m + 3];
            a[h + m] = z < p ? z : p, a[h + m + 3] = b > w ? b : w;
          }
        }
      }
    }
  }
  /**
   * Computes the axis-aligned bounding box of all primitives in the BVH.
   * @param {Box3} target - Target box to write the result into.
   * @returns {Box3}
   */
  getBoundingBox(t) {
    return t.makeEmpty(), this._roots.forEach((i) => {
      N(0, new Float32Array(i), Ss), t.union(Ss);
    }), t;
  }
  /**
   * A generalized traversal function for performing spatial queries against the BVH. Returns
   * `true` as soon as a primitive has been reported as intersected. The tree is traversed
   * depth-first; `boundsTraverseOrder` controls which child is visited first. Returning
   * `CONTAINED` from `intersectsBounds` skips further child traversal and intersects all
   * primitives in that subtree immediately.
   *
   * @param {Object} callbacks
   * @param {IntersectsBoundsCallback} callbacks.intersectsBounds
   * @param {IntersectsRangeCallback} [callbacks.intersectsRange]
   * @param {BoundsTraverseOrderCallback} [callbacks.boundsTraverseOrder]
   * @returns {boolean}
   */
  // TODO: see if we can get rid of "iterateFunc" here as well as the primitive so the function
  // API aligns with the "shapecast" implementation
  shapecast(t) {
    let {
      boundsTraverseOrder: e,
      intersectsBounds: i,
      intersectsRange: s,
      intersectsPrimitive: n,
      scratchPrimitive: r,
      iterate: a
    } = t;
    if (s && n) {
      const l = s;
      s = (u, d, y, m, z) => l(u, d, y, m, z) ? !0 : a(u, d, this, n, y, m, r);
    } else s || (n ? s = (l, u, d, y) => a(l, u, this, n, d, y, r) : s = (l, u, d) => d);
    let o = !1, c = 0;
    const h = this._roots;
    for (let l = 0, u = h.length; l < u; l++) {
      const d = h[l];
      if (o = In(this, l, i, s, e, c), o)
        break;
      c += d.byteLength / J;
    }
    return o;
  }
  /**
   * Simultaneously traverses two BVH structures to find intersecting primitive pairs. Returns
   * `true` as soon as any intersection is reported. Both trees are traversed depth-first with
   * alternating descent. `matrixToLocal` transforms `otherBvh` into the local space of this BVH.
   *
   * @param {BVH} otherBvh
   * @param {Matrix4} matrixToLocal
   * @param {Object} callbacks
   * @param {IntersectsRangesCallback} callbacks.intersectsRanges
   * @returns {boolean}
   */
  bvhcast(t, e, i) {
    let { intersectsRanges: s } = i;
    return Vn(this, t, e, s);
  }
}
function kn() {
  return typeof SharedArrayBuffer < "u";
}
function as(f) {
  return f.index ? f.index.count : f.attributes.position.count;
}
function ui(f) {
  return as(f) / 3;
}
function Rn(f, t = ArrayBuffer) {
  return f > 65535 ? new Uint32Array(new t(4 * f)) : new Uint16Array(new t(2 * f));
}
function Un(f, t) {
  if (!f.index) {
    const e = f.attributes.position.count, i = t.useSharedArrayBuffer ? SharedArrayBuffer : ArrayBuffer, s = Rn(e, i);
    f.setIndex(new mt(s, 1));
    for (let n = 0; n < e; n++)
      s[n] = n;
  }
}
function Nn(f, t, e) {
  const i = as(f) / e, s = t || f.drawRange, n = s.start / e, r = (s.start + s.count) / e, a = Math.max(0, n), o = Math.min(i, r) - a;
  return {
    offset: Math.floor(a),
    count: Math.floor(o)
  };
}
function Ln(f, t) {
  return f.groups.map((e) => ({
    offset: e.start / t,
    count: e.count / t
  }));
}
function Bs(f, t, e) {
  const i = Nn(f, t, e), s = Ln(f, e);
  if (!s.length)
    return [i];
  const n = [], r = i.offset, a = i.offset + i.count, o = as(f) / e, c = [];
  for (const u of s) {
    const { offset: d, count: y } = u, m = d, z = isFinite(y) ? y : o - d, b = d + z;
    m < a && b > r && (c.push({ pos: Math.max(r, m), isStart: !0 }), c.push({ pos: Math.min(a, b), isStart: !1 }));
  }
  c.sort((u, d) => u.pos !== d.pos ? u.pos - d.pos : u.type === "end" ? -1 : 1);
  let h = 0, l = null;
  for (const u of c) {
    const d = u.pos;
    h !== 0 && d !== l && n.push({
      offset: l,
      count: d - l
    }), h += u.isStart ? 1 : -1, l = d;
  }
  return n;
}
function Dn(f, t) {
  const e = f[f.length - 1], i = e.offset + e.count > 2 ** 16, s = f.reduce((c, h) => c + h.count, 0), n = i ? 4 : 2, r = t ? new SharedArrayBuffer(s * n) : new ArrayBuffer(s * n), a = i ? new Uint32Array(r) : new Uint16Array(r);
  let o = 0;
  for (let c = 0; c < f.length; c++) {
    const { offset: h, count: l } = f[c];
    for (let u = 0; u < l; u++)
      a[o + u] = h + u;
    o += l;
  }
  return a;
}
class qn extends Fn {
  /**
   * Whether the BVH was built in indirect mode.
   * @type {boolean}
   * @readonly
   */
  get indirect() {
    return !!this._indirectBuffer;
  }
  get primitiveStride() {
    return null;
  }
  get primitiveBufferStride() {
    return this.indirect ? 1 : this.primitiveStride;
  }
  set primitiveBufferStride(t) {
  }
  get primitiveBuffer() {
    return this.indirect ? this._indirectBuffer : this.geometry.index.array;
  }
  set primitiveBuffer(t) {
  }
  constructor(t, e = {}) {
    if (t.isBufferGeometry) {
      if (t.index && t.index.isInterleavedBufferAttribute)
        throw new Error("BVH: InterleavedBufferAttribute is not supported for the index attribute.");
    } else throw new Error("BVH: Only BufferGeometries are supported.");
    if (e.useSharedArrayBuffer && !kn())
      throw new Error("BVH: SharedArrayBuffer is not available.");
    super(), this.geometry = t, this.resolvePrimitiveIndex = e.indirect ? (i) => this._indirectBuffer[i] : (i) => i, this.primitiveBuffer = null, this.primitiveBufferStride = null, this._indirectBuffer = null, e = {
      ...Xs,
      ...e
    }, e[ns] || this.init(e);
  }
  init(t) {
    const { geometry: e, primitiveStride: i } = this;
    if (t.indirect) {
      const s = Bs(e, t.range, i), n = Dn(s, t.useSharedArrayBuffer);
      this._indirectBuffer = n;
    } else
      Un(e, t);
    super.init(t), !e.boundingBox && t.setBoundingBox && (e.boundingBox = this.getBoundingBox(new Q()));
  }
  // Abstract methods to be implemented by subclasses
  getRootRanges(t) {
    return this.indirect ? [{ offset: 0, count: this._indirectBuffer.length }] : Bs(this.geometry, t, this.primitiveStride);
  }
  raycastObject3D() {
    throw new Error("BVH: raycastObject3D() not implemented");
  }
}
class Bt {
  constructor() {
    this.min = 1 / 0, this.max = -1 / 0;
  }
  setFromPointsField(t, e) {
    let i = 1 / 0, s = -1 / 0;
    for (let n = 0, r = t.length; n < r; n++) {
      const o = t[n][e];
      i = o < i ? o : i, s = o > s ? o : s;
    }
    this.min = i, this.max = s;
  }
  setFromPoints(t, e) {
    let i = 1 / 0, s = -1 / 0;
    for (let n = 0, r = e.length; n < r; n++) {
      const a = e[n], o = t.dot(a);
      i = o < i ? o : i, s = o > s ? o : s;
    }
    this.min = i, this.max = s;
  }
  isSeparated(t) {
    return this.min > t.max || t.min > this.max;
  }
}
Bt.prototype.setFromBox = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new S();
  return function(e, i) {
    const s = i.min, n = i.max;
    let r = 1 / 0, a = -1 / 0;
    for (let o = 0; o <= 1; o++)
      for (let c = 0; c <= 1; c++)
        for (let h = 0; h <= 1; h++) {
          f.x = s.x * o + n.x * (1 - o), f.y = s.y * c + n.y * (1 - c), f.z = s.z * h + n.z * (1 - h);
          const l = e.dot(f);
          r = Math.min(l, r), a = Math.max(l, a);
        }
    this.min = r, this.max = a;
  };
})();
const vn = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new S(), t = /* @__PURE__ */ new S(), e = /* @__PURE__ */ new S();
  return function(s, n, r) {
    const a = s.start, o = f, c = n.start, h = t;
    e.subVectors(a, c), f.subVectors(s.end, s.start), t.subVectors(n.end, n.start);
    const l = e.dot(h), u = h.dot(o), d = h.dot(h), y = e.dot(o), z = o.dot(o) * d - u * u;
    let b, p;
    z !== 0 ? b = (l * u - y * d) / z : b = 0, p = (l + b * u) / d, r.x = b, r.y = p;
  };
})(), cs = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new Z(), t = /* @__PURE__ */ new S(), e = /* @__PURE__ */ new S();
  return function(s, n, r, a) {
    vn(s, n, f);
    let o = f.x, c = f.y;
    if (o >= 0 && o <= 1 && c >= 0 && c <= 1) {
      s.at(o, r), n.at(c, a);
      return;
    } else if (o >= 0 && o <= 1) {
      c < 0 ? n.at(0, a) : n.at(1, a), s.closestPointToPoint(a, !0, r);
      return;
    } else if (c >= 0 && c <= 1) {
      o < 0 ? s.at(0, r) : s.at(1, r), n.closestPointToPoint(r, !0, a);
      return;
    } else {
      let h;
      o < 0 ? h = s.start : h = s.end;
      let l;
      c < 0 ? l = n.start : l = n.end;
      const u = t, d = e;
      if (s.closestPointToPoint(l, !0, t), n.closestPointToPoint(h, !0, e), u.distanceToSquared(l) <= d.distanceToSquared(h)) {
        r.copy(u), a.copy(l);
        return;
      } else {
        r.copy(h), a.copy(d);
        return;
      }
    }
  };
})(), On = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new S(), t = /* @__PURE__ */ new S(), e = /* @__PURE__ */ new qs(), i = /* @__PURE__ */ new St();
  return function(n, r) {
    const { radius: a, center: o } = n, { a: c, b: h, c: l } = r;
    if (i.start = c, i.end = h, i.closestPointToPoint(o, !0, f).distanceTo(o) <= a || (i.start = c, i.end = l, i.closestPointToPoint(o, !0, f).distanceTo(o) <= a) || (i.start = h, i.end = l, i.closestPointToPoint(o, !0, f).distanceTo(o) <= a)) return !0;
    const m = r.getPlane(e);
    if (Math.abs(m.distanceToPoint(o)) <= a) {
      const b = m.projectPoint(o, t);
      if (r.containsPoint(b)) return !0;
    }
    return !1;
  };
})(), Wn = ["x", "y", "z"], At = 1e-15, Ts = At * At;
function rt(f) {
  return Math.abs(f) < At;
}
class dt extends ot {
  constructor(...t) {
    super(...t), this.isExtendedTriangle = !0, this.satAxes = new Array(4).fill().map(() => new S()), this.satBounds = new Array(4).fill().map(() => new Bt()), this.points = [this.a, this.b, this.c], this.plane = new qs(), this.isDegenerateIntoSegment = !1, this.isDegenerateIntoPoint = !1, this.degenerateSegment = new St(), this.needsUpdate = !0;
  }
  /**
   * Returns whether the triangle intersects the given sphere.
   * @param {Sphere} sphere
   * @returns {boolean}
   */
  intersectsSphere(t) {
    return On(t, this);
  }
  update() {
    const t = this.a, e = this.b, i = this.c, s = this.points, n = this.satAxes, r = this.satBounds, a = n[0], o = r[0];
    this.getNormal(a), o.setFromPoints(a, s);
    const c = n[1], h = r[1];
    c.subVectors(t, e), h.setFromPoints(c, s);
    const l = n[2], u = r[2];
    l.subVectors(e, i), u.setFromPoints(l, s);
    const d = n[3], y = r[3];
    d.subVectors(i, t), y.setFromPoints(d, s);
    const m = c.length(), z = l.length(), b = d.length();
    this.isDegenerateIntoPoint = !1, this.isDegenerateIntoSegment = !1, m < At ? z < At || b < At ? this.isDegenerateIntoPoint = !0 : (this.isDegenerateIntoSegment = !0, this.degenerateSegment.start.copy(t), this.degenerateSegment.end.copy(i)) : z < At ? b < At ? this.isDegenerateIntoPoint = !0 : (this.isDegenerateIntoSegment = !0, this.degenerateSegment.start.copy(e), this.degenerateSegment.end.copy(t)) : b < At && (this.isDegenerateIntoSegment = !0, this.degenerateSegment.start.copy(i), this.degenerateSegment.end.copy(e)), this.plane.setFromNormalAndCoplanarPoint(a, t), this.needsUpdate = !1;
  }
}
dt.prototype.closestPointToSegment = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new S(), t = /* @__PURE__ */ new S(), e = /* @__PURE__ */ new St();
  return function(s, n = null, r = null) {
    const { start: a, end: o } = s, c = this.points;
    let h, l = 1 / 0;
    for (let u = 0; u < 3; u++) {
      const d = (u + 1) % 3;
      e.start.copy(c[u]), e.end.copy(c[d]), cs(e, s, f, t), h = f.distanceToSquared(t), h < l && (l = h, n && n.copy(f), r && r.copy(t));
    }
    return this.closestPointToPoint(a, f), h = a.distanceToSquared(f), h < l && (l = h, n && n.copy(f), r && r.copy(a)), this.closestPointToPoint(o, f), h = o.distanceToSquared(f), h < l && (l = h, n && n.copy(f), r && r.copy(o)), Math.sqrt(l);
  };
})();
dt.prototype.intersectsTriangle = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new dt(), t = /* @__PURE__ */ new Bt(), e = /* @__PURE__ */ new Bt(), i = /* @__PURE__ */ new S(), s = /* @__PURE__ */ new S(), n = /* @__PURE__ */ new S(), r = /* @__PURE__ */ new S(), a = /* @__PURE__ */ new St(), o = /* @__PURE__ */ new St(), c = /* @__PURE__ */ new S(), h = /* @__PURE__ */ new Z(), l = /* @__PURE__ */ new Z();
  function u(w, x, g, B) {
    const _ = i;
    !w.isDegenerateIntoPoint && !w.isDegenerateIntoSegment ? _.copy(w.plane.normal) : _.copy(x.plane.normal);
    const M = w.satBounds, P = w.satAxes;
    for (let T = 1; T < 4; T++) {
      const E = M[T], I = P[T];
      if (t.setFromPoints(I, x.points), E.isSeparated(t) || (r.copy(_).cross(I), t.setFromPoints(r, w.points), e.setFromPoints(r, x.points), t.isSeparated(e))) return !1;
    }
    const A = x.satBounds, C = x.satAxes;
    for (let T = 1; T < 4; T++) {
      const E = A[T], I = C[T];
      if (t.setFromPoints(I, w.points), E.isSeparated(t) || (r.crossVectors(_, I), t.setFromPoints(r, w.points), e.setFromPoints(r, x.points), t.isSeparated(e))) return !1;
    }
    return g && (B || console.warn("ExtendedTriangle.intersectsTriangle: Triangles are coplanar which does not support an output edge. Setting edge to 0, 0, 0."), g.start.set(0, 0, 0), g.end.set(0, 0, 0)), !0;
  }
  function d(w, x, g, B, _, M, P, A, C, T, E) {
    let I = P / (P - A);
    T.x = B + (_ - B) * I, E.start.subVectors(x, w).multiplyScalar(I).add(w), I = P / (P - C), T.y = B + (M - B) * I, E.end.subVectors(g, w).multiplyScalar(I).add(w);
  }
  function y(w, x, g, B, _, M, P, A, C, T, E) {
    if (_ > 0)
      d(w.c, w.a, w.b, B, x, g, C, P, A, T, E);
    else if (M > 0)
      d(w.b, w.a, w.c, g, x, B, A, P, C, T, E);
    else if (A * C > 0 || P != 0)
      d(w.a, w.b, w.c, x, g, B, P, A, C, T, E);
    else if (A != 0)
      d(w.b, w.a, w.c, g, x, B, A, P, C, T, E);
    else if (C != 0)
      d(w.c, w.a, w.b, B, x, g, C, P, A, T, E);
    else
      return !0;
    return !1;
  }
  function m(w, x, g, B) {
    const _ = x.degenerateSegment, M = w.plane.distanceToPoint(_.start), P = w.plane.distanceToPoint(_.end);
    return rt(M) ? rt(P) ? u(w, x, g, B) : (g && (g.start.copy(_.start), g.end.copy(_.start)), w.containsPoint(_.start)) : rt(P) ? (g && (g.start.copy(_.end), g.end.copy(_.end)), w.containsPoint(_.end)) : w.plane.intersectLine(_, i) != null ? (g && (g.start.copy(i), g.end.copy(i)), w.containsPoint(i)) : !1;
  }
  function z(w, x, g) {
    const B = x.a;
    return rt(w.plane.distanceToPoint(B)) && w.containsPoint(B) ? (g && (g.start.copy(B), g.end.copy(B)), !0) : !1;
  }
  function b(w, x, g) {
    const B = w.degenerateSegment, _ = x.a;
    return B.closestPointToPoint(_, !0, i), _.distanceToSquared(i) < Ts ? (g && (g.start.copy(_), g.end.copy(_)), !0) : !1;
  }
  function p(w, x, g, B) {
    if (w.isDegenerateIntoSegment)
      if (x.isDegenerateIntoSegment) {
        const _ = w.degenerateSegment, M = x.degenerateSegment, P = s, A = n;
        _.delta(P), M.delta(A);
        const C = i.subVectors(M.start, _.start), T = P.x * A.y - P.y * A.x;
        if (rt(T))
          return !1;
        const E = (C.x * A.y - C.y * A.x) / T, I = -(P.x * C.y - P.y * C.x) / T;
        if (E < 0 || E > 1 || I < 0 || I > 1)
          return !1;
        const V = _.start.z + P.z * E, F = M.start.z + A.z * I;
        return rt(V - F) ? (g && (g.start.copy(_.start).addScaledVector(P, E), g.end.copy(_.start).addScaledVector(P, E)), !0) : !1;
      } else return x.isDegenerateIntoPoint ? b(w, x, g) : m(x, w, g, B);
    else {
      if (w.isDegenerateIntoPoint)
        return x.isDegenerateIntoPoint ? x.a.distanceToSquared(w.a) < Ts ? (g && (g.start.copy(w.a), g.end.copy(w.a)), !0) : !1 : x.isDegenerateIntoSegment ? b(x, w, g) : z(x, w, g);
      if (x.isDegenerateIntoPoint)
        return z(w, x, g);
      if (x.isDegenerateIntoSegment)
        return m(w, x, g, B);
    }
  }
  return function(x, g = null, B = !1) {
    this.needsUpdate && this.update(), x.isExtendedTriangle ? x.needsUpdate && x.update() : (f.copy(x), f.update(), x = f);
    const _ = p(this, x, g, B);
    if (_ !== void 0)
      return _;
    const M = this.plane, P = x.plane;
    let A = P.distanceToPoint(this.a), C = P.distanceToPoint(this.b), T = P.distanceToPoint(this.c);
    rt(A) && (A = 0), rt(C) && (C = 0), rt(T) && (T = 0);
    const E = A * C, I = A * T;
    if (E > 0 && I > 0)
      return !1;
    let V = M.distanceToPoint(x.a), F = M.distanceToPoint(x.b), U = M.distanceToPoint(x.c);
    rt(V) && (V = 0), rt(F) && (F = 0), rt(U) && (U = 0);
    const K = V * F, ct = V * U;
    if (K > 0 && ct > 0)
      return !1;
    s.copy(M.normal), n.copy(P.normal);
    const st = s.cross(n);
    let yt = 0, Zt = Math.abs(st.x);
    const me = Math.abs(st.y);
    me > Zt && (Zt = me, yt = 1), Math.abs(st.z) > Zt && (yt = 2);
    const xt = Wn[yt], Fe = this.a[xt], ke = this.b[xt], Ut = this.c[xt], Nt = x.a[xt], Lt = x.b[xt], pe = x.c[xt];
    if (y(this, Fe, ke, Ut, E, I, A, C, T, h, a))
      return u(this, x, g, B);
    if (y(x, Nt, Lt, pe, K, ct, V, F, U, l, o))
      return u(this, x, g, B);
    if (h.y < h.x) {
      const Dt = h.y;
      h.y = h.x, h.x = Dt, c.copy(a.start), a.start.copy(a.end), a.end.copy(c);
    }
    if (l.y < l.x) {
      const Dt = l.y;
      l.y = l.x, l.x = Dt, c.copy(o.start), o.start.copy(o.end), o.end.copy(c);
    }
    return h.y < l.x || l.y < h.x ? !1 : (g && (l.x > h.x ? g.start.copy(o.start) : g.start.copy(a.start), l.y < h.y ? g.end.copy(o.end) : g.end.copy(a.end)), !0);
  };
})();
dt.prototype.distanceToPoint = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new S();
  return function(e) {
    return this.closestPointToPoint(e, f), e.distanceTo(f);
  };
})();
dt.prototype.distanceToTriangle = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new S(), t = /* @__PURE__ */ new S(), e = ["a", "b", "c"], i = /* @__PURE__ */ new St(), s = /* @__PURE__ */ new St();
  return function(r, a = null, o = null) {
    const c = a || o ? i : null;
    if (this.intersectsTriangle(r, c, !0))
      return (a || o) && (a && c.getCenter(a), o && c.getCenter(o)), 0;
    let h = 1 / 0;
    for (let l = 0; l < 3; l++) {
      let u;
      const d = e[l], y = r[d];
      this.closestPointToPoint(y, f), u = y.distanceToSquared(f), u < h && (h = u, a && a.copy(f), o && o.copy(y));
      const m = this[d];
      r.closestPointToPoint(m, f), u = m.distanceToSquared(f), u < h && (h = u, a && a.copy(m), o && o.copy(f));
    }
    for (let l = 0; l < 3; l++) {
      const u = e[l], d = e[(l + 1) % 3];
      i.set(this[u], this[d]);
      for (let y = 0; y < 3; y++) {
        const m = e[y], z = e[(y + 1) % 3];
        s.set(r[m], r[z]), cs(i, s, f, t);
        const b = f.distanceToSquared(t);
        b < h && (h = b, a && a.copy(f), o && o.copy(t));
      }
    }
    return Math.sqrt(h);
  };
})();
class j {
  constructor(t, e, i) {
    this.isOrientedBox = !0, this.min = new S(), this.max = new S(), this.matrix = new H(), this.invMatrix = new H(), this.points = new Array(8).fill().map(() => new S()), this.satAxes = new Array(3).fill().map(() => new S()), this.satBounds = new Array(3).fill().map(() => new Bt()), this.alignedSatBounds = new Array(3).fill().map(() => new Bt()), this.needsUpdate = !1, t && this.min.copy(t), e && this.max.copy(e), i && this.matrix.copy(i);
  }
  /**
   * Sets the oriented box parameters.
   * @param {Vector3} min
   * @param {Vector3} max
   * @param {Matrix4} matrix
   */
  set(t, e, i) {
    this.min.copy(t), this.max.copy(e), this.matrix.copy(i), this.needsUpdate = !0;
  }
  copy(t) {
    this.min.copy(t.min), this.max.copy(t.max), this.matrix.copy(t.matrix), this.needsUpdate = !0;
  }
}
j.prototype.update = /* @__PURE__ */ (function() {
  return function() {
    const t = this.matrix, e = this.min, i = this.max, s = this.points;
    for (let c = 0; c <= 1; c++)
      for (let h = 0; h <= 1; h++)
        for (let l = 0; l <= 1; l++) {
          const u = 1 * c | 2 * h | 4 * l, d = s[u];
          d.x = c ? i.x : e.x, d.y = h ? i.y : e.y, d.z = l ? i.z : e.z, d.applyMatrix4(t);
        }
    const n = this.satBounds, r = this.satAxes, a = s[0];
    for (let c = 0; c < 3; c++) {
      const h = r[c], l = n[c], u = 1 << c, d = s[u];
      h.subVectors(a, d), l.setFromPoints(h, s);
    }
    const o = this.alignedSatBounds;
    o[0].setFromPointsField(s, "x"), o[1].setFromPointsField(s, "y"), o[2].setFromPointsField(s, "z"), this.invMatrix.copy(this.matrix).invert(), this.needsUpdate = !1;
  };
})();
j.prototype.intersectsBox = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new Bt();
  return function(e) {
    this.needsUpdate && this.update();
    const i = e.min, s = e.max, n = this.satBounds, r = this.satAxes, a = this.alignedSatBounds;
    if (f.min = i.x, f.max = s.x, a[0].isSeparated(f) || (f.min = i.y, f.max = s.y, a[1].isSeparated(f)) || (f.min = i.z, f.max = s.z, a[2].isSeparated(f))) return !1;
    for (let o = 0; o < 3; o++) {
      const c = r[o], h = n[o];
      if (f.setFromBox(c, e), h.isSeparated(f)) return !1;
    }
    return !0;
  };
})();
j.prototype.intersectsTriangle = /* @__PURE__ */ (function() {
  const f = /* @__PURE__ */ new dt(), t = /* @__PURE__ */ new Array(3), e = /* @__PURE__ */ new Bt(), i = /* @__PURE__ */ new Bt(), s = /* @__PURE__ */ new S();
  return function(r) {
    this.needsUpdate && this.update(), r.isExtendedTriangle ? r.needsUpdate && r.update() : (f.copy(r), f.update(), r = f);
    const a = this.satBounds, o = this.satAxes;
    t[0] = r.a, t[1] = r.b, t[2] = r.c;
    for (let u = 0; u < 3; u++) {
      const d = a[u], y = o[u];
      if (e.setFromPoints(y, t), d.isSeparated(e)) return !1;
    }
    const c = r.satBounds, h = r.satAxes, l = this.points;
    for (let u = 0; u < 3; u++) {
      const d = c[u], y = h[u];
      if (e.setFromPoints(y, l), d.isSeparated(e)) return !1;
    }
    for (let u = 0; u < 3; u++) {
      const d = o[u];
      for (let y = 0; y < 4; y++) {
        const m = h[y];
        if (s.crossVectors(d, m), e.setFromPoints(s, t), i.setFromPoints(s, l), e.isSeparated(i)) return !1;
      }
    }
    return !0;
  };
})();
j.prototype.closestPointToPoint = /* @__PURE__ */ (function() {
  return function(t, e) {
    return this.needsUpdate && this.update(), e.copy(t).applyMatrix4(this.invMatrix).clamp(this.min, this.max).applyMatrix4(this.matrix), e;
  };
})();
j.prototype.distanceToPoint = (function() {
  const f = new S();
  return function(e) {
    return this.closestPointToPoint(e, f), e.distanceTo(f);
  };
})();
j.prototype.distanceToBox = /* @__PURE__ */ (function() {
  const f = ["x", "y", "z"], t = /* @__PURE__ */ new Array(12).fill().map(() => new St()), e = /* @__PURE__ */ new Array(12).fill().map(() => new St()), i = /* @__PURE__ */ new S(), s = /* @__PURE__ */ new S();
  return function(r, a = 0, o = null, c = null) {
    if (this.needsUpdate && this.update(), this.intersectsBox(r))
      return (o || c) && (r.getCenter(s), this.closestPointToPoint(s, i), r.closestPointToPoint(i, s), o && o.copy(i), c && c.copy(s)), 0;
    const h = a * a, l = r.min, u = r.max, d = this.points;
    let y = 1 / 0;
    for (let z = 0; z < 8; z++) {
      const b = d[z];
      s.copy(b).clamp(l, u);
      const p = b.distanceToSquared(s);
      if (p < y && (y = p, o && o.copy(b), c && c.copy(s), p < h))
        return Math.sqrt(p);
    }
    let m = 0;
    for (let z = 0; z < 3; z++)
      for (let b = 0; b <= 1; b++)
        for (let p = 0; p <= 1; p++) {
          const w = (z + 1) % 3, x = (z + 2) % 3, g = b << w | p << x, B = 1 << z | b << w | p << x, _ = d[g], M = d[B];
          t[m].set(_, M);
          const A = f[z], C = f[w], T = f[x], E = e[m], I = E.start, V = E.end;
          I[A] = l[A], I[C] = b ? l[C] : u[C], I[T] = p ? l[T] : u[C], V[A] = u[A], V[C] = b ? l[C] : u[C], V[T] = p ? l[T] : u[C], m++;
        }
    for (let z = 0; z <= 1; z++)
      for (let b = 0; b <= 1; b++)
        for (let p = 0; p <= 1; p++) {
          s.x = z ? u.x : l.x, s.y = b ? u.y : l.y, s.z = p ? u.z : l.z, this.closestPointToPoint(s, i);
          const w = s.distanceToSquared(i);
          if (w < y && (y = w, o && o.copy(i), c && c.copy(s), w < h))
            return Math.sqrt(w);
        }
    for (let z = 0; z < 12; z++) {
      const b = t[z];
      for (let p = 0; p < 12; p++) {
        const w = e[p];
        cs(b, w, i, s);
        const x = i.distanceToSquared(s);
        if (x < y && (y = x, o && o.copy(i), c && c.copy(s), x < h))
          return Math.sqrt(x);
      }
    }
    return Math.sqrt(y);
  };
})();
class Xn extends os {
  constructor() {
    super(() => new dt());
  }
}
const at = /* @__PURE__ */ new Xn(), Me = /* @__PURE__ */ new S(), vi = /* @__PURE__ */ new S();
function Yn(f, t, e = {}, i = 0, s = 1 / 0) {
  const n = i * i, r = s * s;
  let a = 1 / 0, o = null;
  if (f.shapecast(
    {
      boundsTraverseOrder: (h) => (Me.copy(t).clamp(h.min, h.max), Me.distanceToSquared(t)),
      intersectsBounds: (h, l, u) => u < a && u < r,
      intersectsTriangle: (h, l) => {
        h.closestPointToPoint(t, Me);
        const u = t.distanceToSquared(Me);
        return u < a && (vi.copy(Me), a = u, o = l), u < n;
      }
    }
  ), a === 1 / 0) return null;
  const c = Math.sqrt(a);
  return e.point ? e.point.copy(vi) : e.point = vi.clone(), e.distance = c, e.faceIndex = o, e;
}
const Ze = parseInt("186") >= 169, Hn = parseInt("186") <= 161, Ot = /* @__PURE__ */ new S(), Wt = /* @__PURE__ */ new S(), Xt = /* @__PURE__ */ new S(), $e = /* @__PURE__ */ new Z(), Je = /* @__PURE__ */ new Z(), Ge = /* @__PURE__ */ new Z(), Ps = /* @__PURE__ */ new S(), Cs = /* @__PURE__ */ new S(), Es = /* @__PURE__ */ new S(), Ae = /* @__PURE__ */ new S();
function Zn(f, t, e, i, s, n, r, a) {
  let o;
  if (n === 1 ? o = f.intersectTriangle(i, e, t, !0, s) : o = f.intersectTriangle(t, e, i, n !== 2, s), o === null) return null;
  const c = f.origin.distanceTo(s);
  return c < r || c > a ? null : {
    distance: c,
    point: s.clone()
  };
}
function Is(f, t, e, i, s, n, r, a, o, c, h) {
  Ot.fromBufferAttribute(t, n), Wt.fromBufferAttribute(t, r), Xt.fromBufferAttribute(t, a);
  const l = Zn(f, Ot, Wt, Xt, Ae, o, c, h);
  if (l) {
    if (i) {
      $e.fromBufferAttribute(i, n), Je.fromBufferAttribute(i, r), Ge.fromBufferAttribute(i, a), l.uv = new Z();
      const d = ot.getInterpolation(Ae, Ot, Wt, Xt, $e, Je, Ge, l.uv);
      Ze || (l.uv = d);
    }
    if (s) {
      $e.fromBufferAttribute(s, n), Je.fromBufferAttribute(s, r), Ge.fromBufferAttribute(s, a), l.uv1 = new Z();
      const d = ot.getInterpolation(Ae, Ot, Wt, Xt, $e, Je, Ge, l.uv1);
      Ze || (l.uv1 = d), Hn && (l.uv2 = l.uv1);
    }
    if (e) {
      Ps.fromBufferAttribute(e, n), Cs.fromBufferAttribute(e, r), Es.fromBufferAttribute(e, a), l.normal = new S();
      const d = ot.getInterpolation(Ae, Ot, Wt, Xt, Ps, Cs, Es, l.normal);
      l.normal.dot(f.direction) > 0 && l.normal.multiplyScalar(-1), Ze || (l.normal = d);
    }
    const u = {
      a: n,
      b: r,
      c: a,
      normal: new S(),
      materialIndex: 0
    };
    if (ot.getNormal(Ot, Wt, Xt, u.normal), l.face = u, l.faceIndex = n, Ze) {
      const d = new S();
      ot.getBarycoord(Ae, Ot, Wt, Xt, d), l.barycoord = d;
    }
  }
  return l;
}
function Vs(f) {
  return f && f.isMaterial ? f.side : f;
}
function fi(f, t, e, i, s, n, r) {
  const a = i * 3;
  let o = a + 0, c = a + 1, h = a + 2;
  const { index: l, groups: u } = f;
  f.index && (o = l.getX(o), c = l.getX(c), h = l.getX(h));
  const { position: d, normal: y, uv: m, uv1: z } = f.attributes;
  if (Array.isArray(t)) {
    const b = i * 3;
    for (let p = 0, w = u.length; p < w; p++) {
      const { start: x, count: g, materialIndex: B } = u[p];
      if (b >= x && b < x + g) {
        const _ = Vs(t[B]), M = Is(e, d, y, m, z, o, c, h, _, n, r);
        if (M)
          if (M.faceIndex = i, M.face.materialIndex = B, s)
            s.push(M);
          else
            return M;
      }
    }
  } else {
    const b = Vs(t), p = Is(e, d, y, m, z, o, c, h, b, n, r);
    if (p)
      if (p.faceIndex = i, p.face.materialIndex = 0, s)
        s.push(p);
      else
        return p;
  }
  return null;
}
function q(f, t, e, i) {
  const s = f.a, n = f.b, r = f.c;
  let a = t, o = t + 1, c = t + 2;
  e && (a = e.getX(a), o = e.getX(o), c = e.getX(c)), s.x = i.getX(a), s.y = i.getY(a), s.z = i.getZ(a), n.x = i.getX(o), n.y = i.getY(o), n.z = i.getZ(o), r.x = i.getX(c), r.y = i.getY(c), r.z = i.getZ(c);
}
function $n(f, t, e, i, s, n, r, a) {
  const { geometry: o, _indirectBuffer: c } = f;
  for (let h = i, l = i + s; h < l; h++)
    fi(o, t, e, h, n, r, a);
}
function Jn(f, t, e, i, s, n, r) {
  const { geometry: a, _indirectBuffer: o } = f;
  let c = 1 / 0, h = null;
  for (let l = i, u = i + s; l < u; l++) {
    let d;
    d = fi(a, t, e, l, null, n, r), d && d.distance < c && (h = d, c = d.distance);
  }
  return h;
}
function Gn(f, t, e, i, s, n, r) {
  const { geometry: a } = e, { index: o } = a, c = a.attributes.position;
  for (let h = f, l = t + f; h < l; h++) {
    let u;
    if (u = h, q(r, u * 3, o, c), r.needsUpdate = !0, i(r, u, s, n))
      return !0;
  }
  return !1;
}
function Qn(f, t = null) {
  t && Array.isArray(t) && (t = new Set(t));
  const e = f.geometry, i = e.index ? e.index.array : null, s = e.attributes.position;
  let n, r, a, o, c = 0;
  const h = f._roots;
  for (let u = 0, d = h.length; u < d; u++)
    n = h[u], r = new Uint32Array(n), a = new Uint16Array(n), o = new Float32Array(n), l(0, c), c += n.byteLength;
  function l(u, d, y = !1) {
    const m = u * 2;
    if (L(m, a)) {
      const z = Y(u, r), b = G(m, a);
      let p = 1 / 0, w = 1 / 0, x = 1 / 0, g = -1 / 0, B = -1 / 0, _ = -1 / 0;
      for (let M = 3 * z, P = 3 * (z + b); M < P; M++) {
        let A = i[M];
        const C = s.getX(A), T = s.getY(A), E = s.getZ(A);
        C < p && (p = C), C > g && (g = C), T < w && (w = T), T > B && (B = T), E < x && (x = E), E > _ && (_ = E);
      }
      return o[u + 0] !== p || o[u + 1] !== w || o[u + 2] !== x || o[u + 3] !== g || o[u + 4] !== B || o[u + 5] !== _ ? (o[u + 0] = p, o[u + 1] = w, o[u + 2] = x, o[u + 3] = g, o[u + 4] = B, o[u + 5] = _, !0) : !1;
    } else {
      const z = O(u), b = W(u, r);
      let p = y, w = !1, x = !1;
      if (t) {
        if (!p) {
          const A = z / v + d / J, C = b / v + d / J;
          w = t.has(A), x = t.has(C), p = !w && !x;
        }
      } else
        w = !0, x = !0;
      const g = p || w, B = p || x;
      let _ = !1;
      g && (_ = l(z, d, p));
      let M = !1;
      B && (M = l(b, d, p));
      const P = _ || M;
      if (P)
        for (let A = 0; A < 3; A++) {
          const C = z + A, T = b + A, E = o[C], I = o[C + 3], V = o[T], F = o[T + 3];
          o[u + A] = E < V ? E : V, o[u + A + 3] = I > F ? I : F;
        }
      return P;
    }
  }
}
function Rt(f, t, e, i, s) {
  let n, r, a, o, c, h;
  const l = 1 / e.direction.x, u = 1 / e.direction.y, d = 1 / e.direction.z, y = e.origin.x, m = e.origin.y, z = e.origin.z;
  let b = t[f], p = t[f + 3], w = t[f + 1], x = t[f + 3 + 1], g = t[f + 2], B = t[f + 3 + 2];
  return l >= 0 ? (n = (b - y) * l, r = (p - y) * l) : (n = (p - y) * l, r = (b - y) * l), u >= 0 ? (a = (w - m) * u, o = (x - m) * u) : (a = (x - m) * u, o = (w - m) * u), n > o || a > r || ((a > n || isNaN(n)) && (n = a), (o < r || isNaN(r)) && (r = o), d >= 0 ? (c = (g - z) * d, h = (B - z) * d) : (c = (B - z) * d, h = (g - z) * d), n > h || c > r) ? !1 : ((c > n || n !== n) && (n = c), (h < r || r !== r) && (r = h), n <= s && r >= i);
}
function jn(f, t, e, i, s, n, r, a) {
  const { geometry: o, _indirectBuffer: c } = f;
  for (let h = i, l = i + s; h < l; h++) {
    let u = c ? c[h] : h;
    fi(o, t, e, u, n, r, a);
  }
}
function Kn(f, t, e, i, s, n, r) {
  const { geometry: a, _indirectBuffer: o } = f;
  let c = 1 / 0, h = null;
  for (let l = i, u = i + s; l < u; l++) {
    let d;
    d = fi(a, t, e, o ? o[l] : l, null, n, r), d && d.distance < c && (h = d, c = d.distance);
  }
  return h;
}
function tr(f, t, e, i, s, n, r) {
  const { geometry: a } = e, { index: o } = a, c = a.attributes.position;
  for (let h = f, l = t + f; h < l; h++) {
    let u;
    if (u = e.resolveTriangleIndex(h), q(r, u * 3, o, c), r.needsUpdate = !0, i(r, u, s, n))
      return !0;
  }
  return !1;
}
function er(f, t, e, i, s, n, r) {
  R.setBuffer(f._roots[t]), Qi(0, f, e, i, s, n, r), R.clearBuffer();
}
function Qi(f, t, e, i, s, n, r) {
  const { float32Array: a, uint16Array: o, uint32Array: c } = R, h = f * 2;
  if (L(h, o)) {
    const u = Y(f, c), d = G(h, o);
    $n(t, e, i, u, d, s, n, r);
  } else {
    const u = O(f);
    Rt(u, a, i, n, r) && Qi(u, t, e, i, s, n, r);
    const d = W(f, c);
    Rt(d, a, i, n, r) && Qi(d, t, e, i, s, n, r);
  }
}
const ir = ["x", "y", "z"];
function sr(f, t, e, i, s, n) {
  R.setBuffer(f._roots[t]);
  const r = ji(0, f, e, i, s, n);
  return R.clearBuffer(), r;
}
function ji(f, t, e, i, s, n) {
  const { float32Array: r, uint16Array: a, uint32Array: o } = R;
  let c = f * 2;
  if (L(c, a)) {
    const l = Y(f, o), u = G(c, a);
    return Jn(t, e, i, l, u, s, n);
  } else {
    const l = rs(f, o), u = ir[l], y = i.direction[u] >= 0;
    let m, z;
    y ? (m = O(f), z = W(f, o)) : (m = W(f, o), z = O(f));
    const p = Rt(m, r, i, s, n) ? ji(m, t, e, i, s, n) : null;
    if (p) {
      const g = p.point[u];
      if (y ? g <= r[z + l] : (
        // min bounding data
        g >= r[z + l + 3]
      ))
        return p;
    }
    const x = Rt(z, r, i, s, n) ? ji(z, t, e, i, s, n) : null;
    return p && x ? p.distance <= x.distance ? p : x : p || x || null;
  }
}
const Qe = /* @__PURE__ */ new Q(), le = /* @__PURE__ */ new dt(), ue = /* @__PURE__ */ new dt(), Se = /* @__PURE__ */ new H(), Fs = /* @__PURE__ */ new j(), je = /* @__PURE__ */ new j();
function nr(f, t, e, i) {
  R.setBuffer(f._roots[t]);
  const s = Ki(0, f, e, i);
  return R.clearBuffer(), s;
}
function Ki(f, t, e, i, s = null) {
  const { float32Array: n, uint16Array: r, uint32Array: a } = R;
  let o = f * 2;
  if (s === null && (e.boundingBox || e.computeBoundingBox(), Fs.set(e.boundingBox.min, e.boundingBox.max, i), s = Fs), L(o, r)) {
    const h = t.geometry, l = h.index, u = h.attributes.position, d = e.index, y = e.attributes.position, m = Y(f, a), z = G(o, r);
    if (Se.copy(i).invert(), e.boundsTree)
      return N(f, n, je), je.matrix.copy(Se), je.needsUpdate = !0, e.boundsTree.shapecast({
        intersectsBounds: (p) => je.intersectsBox(p),
        intersectsTriangle: (p) => {
          p.a.applyMatrix4(i), p.b.applyMatrix4(i), p.c.applyMatrix4(i), p.needsUpdate = !0;
          for (let w = m * 3, x = (z + m) * 3; w < x; w += 3)
            if (q(ue, w, l, u), ue.needsUpdate = !0, p.intersectsTriangle(ue))
              return !0;
          return !1;
        }
      });
    {
      const b = ui(e);
      for (let p = m * 3, w = (z + m) * 3; p < w; p += 3) {
        q(le, p, l, u), le.a.applyMatrix4(Se), le.b.applyMatrix4(Se), le.c.applyMatrix4(Se), le.needsUpdate = !0;
        for (let x = 0, g = b * 3; x < g; x += 3)
          if (q(ue, x, d, y), ue.needsUpdate = !0, le.intersectsTriangle(ue))
            return !0;
      }
    }
  } else {
    const h = O(f), l = W(f, a);
    return N(h, n, Qe), !!(s.intersectsBox(Qe) && Ki(h, t, e, i, s) || (N(l, n, Qe), s.intersectsBox(Qe) && Ki(l, t, e, i, s)));
  }
}
const Ke = /* @__PURE__ */ new H(), Oi = /* @__PURE__ */ new j(), Be = /* @__PURE__ */ new j(), rr = /* @__PURE__ */ new S(), or = /* @__PURE__ */ new S(), ar = /* @__PURE__ */ new S(), cr = /* @__PURE__ */ new S();
function hr(f, t, e, i = {}, s = {}, n = 0, r = 1 / 0) {
  t.boundingBox || t.computeBoundingBox(), Oi.set(t.boundingBox.min, t.boundingBox.max, e), Oi.needsUpdate = !0;
  const a = f.geometry, o = a.attributes.position, c = a.index, h = t.attributes.position, l = t.index, u = at.getPrimitive(), d = at.getPrimitive();
  let y = rr, m = or, z = null, b = null;
  s && (z = ar, b = cr);
  let p = 1 / 0, w = null, x = null;
  return Ke.copy(e).invert(), Be.matrix.copy(Ke), f.shapecast(
    {
      boundsTraverseOrder: (g) => Oi.distanceToBox(g),
      intersectsBounds: (g, B, _) => _ < p && _ < r ? (B && (Be.min.copy(g.min), Be.max.copy(g.max), Be.needsUpdate = !0), !0) : !1,
      intersectsRange: (g, B) => {
        if (t.boundsTree)
          return t.boundsTree.shapecast({
            boundsTraverseOrder: (M) => Be.distanceToBox(M),
            intersectsBounds: (M, P, A) => A < p && A < r,
            intersectsRange: (M, P) => {
              for (let A = M, C = M + P; A < C; A++) {
                q(d, 3 * A, l, h), d.a.applyMatrix4(e), d.b.applyMatrix4(e), d.c.applyMatrix4(e), d.needsUpdate = !0;
                for (let T = g, E = g + B; T < E; T++) {
                  q(u, 3 * T, c, o), u.needsUpdate = !0;
                  const I = u.distanceToTriangle(d, y, z);
                  if (I < p && (m.copy(y), b && b.copy(z), p = I, w = T, x = A), I < n)
                    return !0;
                }
              }
            }
          });
        {
          const _ = ui(t);
          for (let M = 0, P = _; M < P; M++) {
            q(d, 3 * M, l, h), d.a.applyMatrix4(e), d.b.applyMatrix4(e), d.c.applyMatrix4(e), d.needsUpdate = !0;
            for (let A = g, C = g + B; A < C; A++) {
              q(u, 3 * A, c, o), u.needsUpdate = !0;
              const T = u.distanceToTriangle(d, y, z);
              if (T < p && (m.copy(y), b && b.copy(z), p = T, w = A, x = M), T < n)
                return !0;
            }
          }
        }
      }
    }
  ), at.releasePrimitive(u), at.releasePrimitive(d), p === 1 / 0 ? null : (i.point ? i.point.copy(m) : i.point = m.clone(), i.distance = p, i.faceIndex = w, s && (s.point ? s.point.copy(b) : s.point = b.clone(), s.point.applyMatrix4(Ke), m.applyMatrix4(Ke), s.distance = m.sub(s.point).length(), s.faceIndex = x), i);
}
function lr(f, t = null) {
  t && Array.isArray(t) && (t = new Set(t));
  const e = f.geometry, i = e.index ? e.index.array : null, s = e.attributes.position;
  let n, r, a, o, c = 0;
  const h = f._roots;
  for (let u = 0, d = h.length; u < d; u++)
    n = h[u], r = new Uint32Array(n), a = new Uint16Array(n), o = new Float32Array(n), l(0, c), c += n.byteLength;
  function l(u, d, y = !1) {
    const m = u * 2;
    if (L(m, a)) {
      const z = Y(u, r), b = G(m, a);
      let p = 1 / 0, w = 1 / 0, x = 1 / 0, g = -1 / 0, B = -1 / 0, _ = -1 / 0;
      for (let M = z, P = z + b; M < P; M++) {
        const A = 3 * f.resolveTriangleIndex(M);
        for (let C = 0; C < 3; C++) {
          let T = A + C;
          T = i ? i[T] : T;
          const E = s.getX(T), I = s.getY(T), V = s.getZ(T);
          E < p && (p = E), E > g && (g = E), I < w && (w = I), I > B && (B = I), V < x && (x = V), V > _ && (_ = V);
        }
      }
      return o[u + 0] !== p || o[u + 1] !== w || o[u + 2] !== x || o[u + 3] !== g || o[u + 4] !== B || o[u + 5] !== _ ? (o[u + 0] = p, o[u + 1] = w, o[u + 2] = x, o[u + 3] = g, o[u + 4] = B, o[u + 5] = _, !0) : !1;
    } else {
      const z = O(u), b = W(u, r);
      let p = y, w = !1, x = !1;
      if (t) {
        if (!p) {
          const A = z / v + d / J, C = b / v + d / J;
          w = t.has(A), x = t.has(C), p = !w && !x;
        }
      } else
        w = !0, x = !0;
      const g = p || w, B = p || x;
      let _ = !1;
      g && (_ = l(z, d, p));
      let M = !1;
      B && (M = l(b, d, p));
      const P = _ || M;
      if (P)
        for (let A = 0; A < 3; A++) {
          const C = z + A, T = b + A, E = o[C], I = o[C + 3], V = o[T], F = o[T + 3];
          o[u + A] = E < V ? E : V, o[u + A + 3] = I > F ? I : F;
        }
      return P;
    }
  }
}
function ur(f, t, e, i, s, n, r) {
  R.setBuffer(f._roots[t]), ts(0, f, e, i, s, n, r), R.clearBuffer();
}
function ts(f, t, e, i, s, n, r) {
  const { float32Array: a, uint16Array: o, uint32Array: c } = R, h = f * 2;
  if (L(h, o)) {
    const u = Y(f, c), d = G(h, o);
    jn(t, e, i, u, d, s, n, r);
  } else {
    const u = O(f);
    Rt(u, a, i, n, r) && ts(u, t, e, i, s, n, r);
    const d = W(f, c);
    Rt(d, a, i, n, r) && ts(d, t, e, i, s, n, r);
  }
}
const fr = ["x", "y", "z"];
function dr(f, t, e, i, s, n) {
  R.setBuffer(f._roots[t]);
  const r = es(0, f, e, i, s, n);
  return R.clearBuffer(), r;
}
function es(f, t, e, i, s, n) {
  const { float32Array: r, uint16Array: a, uint32Array: o } = R;
  let c = f * 2;
  if (L(c, a)) {
    const l = Y(f, o), u = G(c, a);
    return Kn(t, e, i, l, u, s, n);
  } else {
    const l = rs(f, o), u = fr[l], y = i.direction[u] >= 0;
    let m, z;
    y ? (m = O(f), z = W(f, o)) : (m = W(f, o), z = O(f));
    const p = Rt(m, r, i, s, n) ? es(m, t, e, i, s, n) : null;
    if (p) {
      const g = p.point[u];
      if (y ? g <= r[z + l] : (
        // min bounding data
        g >= r[z + l + 3]
      ))
        return p;
    }
    const x = Rt(z, r, i, s, n) ? es(z, t, e, i, s, n) : null;
    return p && x ? p.distance <= x.distance ? p : x : p || x || null;
  }
}
const ti = /* @__PURE__ */ new Q(), fe = /* @__PURE__ */ new dt(), de = /* @__PURE__ */ new dt(), Te = /* @__PURE__ */ new H(), ks = /* @__PURE__ */ new j(), ei = /* @__PURE__ */ new j();
function yr(f, t, e, i) {
  R.setBuffer(f._roots[t]);
  const s = is(0, f, e, i);
  return R.clearBuffer(), s;
}
function is(f, t, e, i, s = null) {
  const { float32Array: n, uint16Array: r, uint32Array: a } = R;
  let o = f * 2;
  if (s === null && (e.boundingBox || e.computeBoundingBox(), ks.set(e.boundingBox.min, e.boundingBox.max, i), s = ks), L(o, r)) {
    const h = t.geometry, l = h.index, u = h.attributes.position, d = e.index, y = e.attributes.position, m = Y(f, a), z = G(o, r);
    if (Te.copy(i).invert(), e.boundsTree)
      return N(f, n, ei), ei.matrix.copy(Te), ei.needsUpdate = !0, e.boundsTree.shapecast({
        intersectsBounds: (p) => ei.intersectsBox(p),
        intersectsTriangle: (p) => {
          p.a.applyMatrix4(i), p.b.applyMatrix4(i), p.c.applyMatrix4(i), p.needsUpdate = !0;
          for (let w = m, x = z + m; w < x; w++)
            if (q(de, 3 * t.resolveTriangleIndex(w), l, u), de.needsUpdate = !0, p.intersectsTriangle(de))
              return !0;
          return !1;
        }
      });
    {
      const b = ui(e);
      for (let p = m, w = z + m; p < w; p++) {
        const x = t.resolveTriangleIndex(p);
        q(fe, 3 * x, l, u), fe.a.applyMatrix4(Te), fe.b.applyMatrix4(Te), fe.c.applyMatrix4(Te), fe.needsUpdate = !0;
        for (let g = 0, B = b * 3; g < B; g += 3)
          if (q(de, g, d, y), de.needsUpdate = !0, fe.intersectsTriangle(de))
            return !0;
      }
    }
  } else {
    const h = O(f), l = W(f, a);
    return N(h, n, ti), !!(s.intersectsBox(ti) && is(h, t, e, i, s) || (N(l, n, ti), s.intersectsBox(ti) && is(l, t, e, i, s)));
  }
}
const ii = /* @__PURE__ */ new H(), Wi = /* @__PURE__ */ new j(), Pe = /* @__PURE__ */ new j(), mr = /* @__PURE__ */ new S(), pr = /* @__PURE__ */ new S(), xr = /* @__PURE__ */ new S(), gr = /* @__PURE__ */ new S();
function wr(f, t, e, i = {}, s = {}, n = 0, r = 1 / 0) {
  t.boundingBox || t.computeBoundingBox(), Wi.set(t.boundingBox.min, t.boundingBox.max, e), Wi.needsUpdate = !0;
  const a = f.geometry, o = a.attributes.position, c = a.index, h = t.attributes.position, l = t.index, u = at.getPrimitive(), d = at.getPrimitive();
  let y = mr, m = pr, z = null, b = null;
  s && (z = xr, b = gr);
  let p = 1 / 0, w = null, x = null;
  return ii.copy(e).invert(), Pe.matrix.copy(ii), f.shapecast(
    {
      boundsTraverseOrder: (g) => Wi.distanceToBox(g),
      intersectsBounds: (g, B, _) => _ < p && _ < r ? (B && (Pe.min.copy(g.min), Pe.max.copy(g.max), Pe.needsUpdate = !0), !0) : !1,
      intersectsRange: (g, B) => {
        if (t.boundsTree) {
          const _ = t.boundsTree;
          return _.shapecast({
            boundsTraverseOrder: (M) => Pe.distanceToBox(M),
            intersectsBounds: (M, P, A) => A < p && A < r,
            intersectsRange: (M, P) => {
              for (let A = M, C = M + P; A < C; A++) {
                const T = _.resolveTriangleIndex(A);
                q(d, 3 * T, l, h), d.a.applyMatrix4(e), d.b.applyMatrix4(e), d.c.applyMatrix4(e), d.needsUpdate = !0;
                for (let E = g, I = g + B; E < I; E++) {
                  const V = f.resolveTriangleIndex(E);
                  q(u, 3 * V, c, o), u.needsUpdate = !0;
                  const F = u.distanceToTriangle(d, y, z);
                  if (F < p && (m.copy(y), b && b.copy(z), p = F, w = E, x = A), F < n)
                    return !0;
                }
              }
            }
          });
        } else {
          const _ = ui(t);
          for (let M = 0, P = _; M < P; M++) {
            q(d, 3 * M, l, h), d.a.applyMatrix4(e), d.b.applyMatrix4(e), d.c.applyMatrix4(e), d.needsUpdate = !0;
            for (let A = g, C = g + B; A < C; A++) {
              const T = f.resolveTriangleIndex(A);
              q(u, 3 * T, c, o), u.needsUpdate = !0;
              const E = u.distanceToTriangle(d, y, z);
              if (E < p && (m.copy(y), b && b.copy(z), p = E, w = A, x = M), E < n)
                return !0;
            }
          }
        }
      }
    }
  ), at.releasePrimitive(u), at.releasePrimitive(d), p === 1 / 0 ? null : (i.point ? i.point.copy(m) : i.point = m.clone(), i.distance = p, i.faceIndex = w, s && (s.point ? s.point.copy(b) : s.point = b.clone(), s.point.applyMatrix4(ii), m.applyMatrix4(ii), s.distance = m.sub(s.point).length(), s.faceIndex = x), i);
}
function Rs(f, t, e) {
  return f === null ? null : (f.point.applyMatrix4(t.matrixWorld), f.distance = f.point.distanceTo(e.ray.origin), f.object = t, f);
}
const si = /* @__PURE__ */ new j(), ni = /* @__PURE__ */ new mn(), Us = /* @__PURE__ */ new S(), Ns = /* @__PURE__ */ new H(), Ls = /* @__PURE__ */ new S(), Xi = ["getX", "getY", "getZ"];
class Ee extends qn {
  /**
   * Generates a representation of the complete bounds tree and the geometry index buffer which
   * can be used to recreate a bounds tree using the `deserialize` function. The `serialize` and
   * `deserialize` functions can be used to generate a MeshBVH asynchronously in a background web
   * worker to prevent the main thread from stuttering. The BVH roots buffer stored in the
   * serialized representation are the same as the ones used by the original BVH so they should
   * not be modified. If `SharedArrayBuffers` are used then the same BVH memory can be used for
   * multiple BVH in multiple WebWorkers.
   *
   * @static
   * @param {MeshBVH} bvh - The BVH to serialize.
   * @param {Object} [options]
   * @param {boolean} [options.cloneBuffers=true] - If `true`, the index and BVH root buffers
   *   are cloned so the serialized data is independent of the live BVH.
   * @returns {SerializedBVH}
   */
  static serialize(t, e = {}) {
    e = {
      cloneBuffers: !0,
      ...e
    };
    const i = t.geometry, s = t._roots, n = t._indirectBuffer, r = i.getIndex(), a = {
      version: 1,
      roots: null,
      index: null,
      indirectBuffer: null
    };
    return e.cloneBuffers ? (a.roots = s.map((o) => o.slice()), a.index = r ? r.array.slice() : null, a.indirectBuffer = n ? n.slice() : null) : (a.roots = s, a.index = r ? r.array : null, a.indirectBuffer = n), a;
  }
  /**
   * Returns a new MeshBVH instance from the serialized data. `geometry` is the geometry used
   * to generate the original BVH `data` was derived from. The root buffers stored in `data`
   * are set directly on the new BVH so the memory is shared.
   *
   * @static
   * @param {SerializedBVH} data - Serialized BVH data.
   * @param {BufferGeometry} geometry - The geometry the BVH was originally built from.
   * @param {Object} [options]
   * @param {boolean} [options.setIndex=true] - If `true`, sets `geometry.index` from the
   *   serialized index buffer (creating one if none exists).
   * @returns {MeshBVH}
   */
  static deserialize(t, e, i = {}) {
    i = {
      setIndex: !0,
      indirect: !!t.indirectBuffer,
      ...i
    };
    const { index: s, roots: n, indirectBuffer: r } = t;
    t.version || (console.warn(
      "MeshBVH.deserialize: Serialization format has been changed and will be fixed up. It is recommended to regenerate any stored serialized data."
    ), o(n));
    const a = new Ee(e, { ...i, [ns]: !0 });
    if (a._roots = n, a._indirectBuffer = r || null, i.setIndex) {
      const c = e.getIndex();
      if (c === null) {
        const h = new mt(t.index, 1, !1);
        e.setIndex(h);
      } else c.array !== s && (c.array.set(s), c.needsUpdate = !0);
    }
    return a;
    function o(c) {
      for (let h = 0; h < c.length; h++) {
        const l = c[h], u = new Uint32Array(l), d = new Uint16Array(l);
        for (let y = 0, m = l.byteLength / J; y < m; y++) {
          const z = v * y, b = 2 * z;
          L(b, d) || (u[z + 6] = u[z + 6] / v - y);
        }
      }
    }
  }
  get primitiveStride() {
    return 3;
  }
  /**
   * Helper function for use when `indirect` is set to true. This function takes a triangle
   * index in the BVH layout and returns the associated triangle index in the geometry index
   * buffer or position attribute.
   * @type {function(number): number}
   * @readonly
   */
  get resolveTriangleIndex() {
    return this.resolvePrimitiveIndex;
  }
  constructor(t, e = {}) {
    e.maxLeafTris && (console.warn('MeshBVH: "maxLeafTris" option has been deprecated. Use "targetLeafSize", instead.'), e = {
      ...e,
      targetLeafSize: e.maxLeafTris
    }), super(t, e);
  }
  /**
   * Adjusts all triangle offsets stored in the BVH by the given offset. This is useful when the
   * triangle data has been compacted or shifted in the geometry buffers (e.g. in `BatchedMesh`
   * when geometries are compacted using the 'optimize' function or constructing a 'merged' BVH).
   * This function only adjusts the BVH to point to different triangles in the geometry. The
   * geometry's index buffer and/or position attributes must be updated separately to match.
   *
   * @param {number} offset
   * @returns {void}
   */
  // implement abstract methods from BVH base class
  shiftTriangleOffsets(t) {
    return super.shiftPrimitiveOffsets(t);
  }
  // write primitive bounds to the buffer - used only for validateBounds at the moment
  writePrimitiveBounds(t, e, i) {
    const s = this.geometry, n = this._indirectBuffer, r = s.attributes.position, a = s.index ? s.index.array : null, c = (n ? n[t] : t) * 3;
    let h = c + 0, l = c + 1, u = c + 2;
    a && (h = a[h], l = a[l], u = a[u]);
    for (let d = 0; d < 3; d++) {
      const y = r[Xi[d]](h), m = r[Xi[d]](l), z = r[Xi[d]](u);
      let b = y;
      m < b && (b = m), z < b && (b = z);
      let p = y;
      m > p && (p = m), z > p && (p = z), e[i + d] = b, e[i + d + 3] = p;
    }
    return e;
  }
  // precomputes the bounding box for each triangle; required for quickly calculating tree splits.
  // result is an array of size count * 6 where triangle i maps to a
  // [x_center, x_delta, y_center, y_delta, z_center, z_delta] tuple starting at index (i - offset) * 6,
  // representing the center and half-extent in each dimension of triangle i
  computePrimitiveBounds(t, e, i) {
    const s = this.geometry, n = this._indirectBuffer, r = s.attributes.position, a = s.index ? s.index.array : null, o = r.normalized;
    if (t < 0 || e + t - i.offset > i.length / 6)
      throw new Error("MeshBVH: compute triangle bounds range is invalid.");
    const c = r.array, h = r.offset || 0;
    let l = 3;
    r.isInterleavedBufferAttribute && (l = r.data.stride);
    const u = ["getX", "getY", "getZ"], d = i.offset;
    for (let y = t, m = t + e; y < m; y++) {
      const b = (n ? n[y] : y) * 3, p = (y - d) * 6;
      let w = b + 0, x = b + 1, g = b + 2;
      a && (w = a[w], x = a[x], g = a[g]), o || (w = w * l + h, x = x * l + h, g = g * l + h);
      for (let B = 0; B < 3; B++) {
        let _, M, P;
        o ? (_ = r[u[B]](w), M = r[u[B]](x), P = r[u[B]](g)) : (_ = c[w + B], M = c[x + B], P = c[g + B]);
        let A = _;
        M < A && (A = M), P < A && (A = P);
        let C = _;
        M > C && (C = M), P > C && (C = P);
        const T = (C - A) / 2, E = B * 2;
        i[p + E + 0] = A + T, i[p + E + 1] = T + (Math.abs(A) + T) * ri;
      }
    }
    return i;
  }
  /**
   * A convenience function for performing a raycast based on a mesh. Results are formed like
   * three.js raycast results in world frame.
   *
   * @param {Object3D} object
   * @param {Raycaster} raycaster
   * @param {Array<Intersection>} [intersects=[]]
   * @returns {Array<Intersection>}
   */
  raycastObject3D(t, e, i = []) {
    const { material: s } = t;
    if (s === void 0)
      return;
    Ns.copy(t.matrixWorld).invert(), ni.copy(e.ray).applyMatrix4(Ns), Ls.setFromMatrixScale(t.matrixWorld), Us.copy(ni.direction).multiply(Ls);
    const n = Us.length(), r = e.near / n, a = e.far / n;
    if (e.firstHitOnly === !0) {
      let o = this.raycastFirst(ni, s, r, a);
      o = Rs(o, t, e), o && i.push(o);
    } else {
      const o = this.raycast(ni, s, r, a);
      for (let c = 0, h = o.length; c < h; c++) {
        const l = Rs(o[c], t, e);
        l && i.push(l);
      }
    }
    return i;
  }
  /**
   * Refit the node bounds to the current triangle positions. This is quicker than regenerating
   * a new BVH but will not be optimal after significant changes to the vertices. `nodeIndices`
   * is a set of node indices (provided by the `shapecast` function) that need to be refit
   * including all internal nodes.
   *
   * @param {Set<number>|Array<number>|null} [nodeIndices=null]
   */
  refit(t = null) {
    return (this.indirect ? lr : Qn)(this, t);
  }
  /* Core Cast Functions */
  /**
   * Returns all raycast triangle hits in unsorted order. It is expected that `ray` is in the
   * frame of the BVH already. Likewise the returned results are also provided in the local
   * frame of the BVH. The `side` identifier is used to determine the side to check when
   * raycasting or a material with the given side field can be passed. If an array of materials
   * is provided then it is expected that the geometry has groups and the appropriate material
   * side is used per group.
   *
   * Note that unlike three.js' Raycaster results the points and distances in the intersections
   * returned from this function are relative to the local frame of the MeshBVH. When using the
   * `acceleratedRaycast` function as an override for `Mesh.raycast` they are transformed into
   * world space to be consistent with three's results.
   *
   * @param {Ray} ray
   * @param {number|Material|Array<Material>} [materialOrSide=FrontSide]
   * @param {number} [near=0]
   * @param {number} [far=Infinity]
   * @returns {Array<Intersection>}
   */
  raycast(t, e = 0, i = 0, s = 1 / 0) {
    const n = this._roots, r = [], a = this.indirect ? ur : er;
    for (let o = 0, c = n.length; o < c; o++)
      a(this, o, e, t, r, i, s);
    return r;
  }
  /**
   * Returns the first raycast hit in the model. This is typically much faster than returning
   * all hits. See `raycast` for information on the side and material options as well as the
   * frame of the returned intersections.
   *
   * @param {Ray} ray
   * @param {number|Material|Array<Material>} [materialOrSide=FrontSide]
   * @param {number} [near=0]
   * @param {number} [far=Infinity]
   * @returns {Intersection|null}
   */
  raycastFirst(t, e = 0, i = 0, s = 1 / 0) {
    const n = this._roots;
    let r = null;
    const a = this.indirect ? dr : sr;
    for (let o = 0, c = n.length; o < c; o++) {
      const h = a(this, o, e, t, i, s);
      h != null && (r == null || h.distance < r.distance) && (r = h);
    }
    return r;
  }
  /**
   * Returns whether or not the mesh intersects the given geometry.
   *
   * The `geometryToBvh` parameter is the transform of the geometry in the BVH's local frame.
   *
   * Performance improves considerably if the provided geometry also has a `boundsTree`.
   *
   * @param {BufferGeometry} otherGeometry
   * @param {Matrix4} geometryToBvh - Transform of `otherGeometry` into the local space of
   *   this BVH.
   * @returns {boolean}
   */
  intersectsGeometry(t, e) {
    let i = !1;
    const s = this._roots, n = this.indirect ? yr : nr;
    for (let r = 0, a = s.length; r < a && (i = n(this, r, t, e), !i); r++)
      ;
    return i;
  }
  /**
   * A generalized cast function that can be used to implement intersection logic for custom
   * shapes. This is used internally for `intersectsBox`, `intersectsSphere`, and more. The
   * function returns as soon as a triangle has been reported as intersected and returns `true`
   * if a triangle has been intersected.
   *
   * @param {Object} callbacks
   * @param {IntersectsBoundsCallback} callbacks.intersectsBounds
   * @param {IntersectsTriangleCallback} [callbacks.intersectsTriangle]
   * @param {IntersectsRangeCallback} [callbacks.intersectsRange]
   * @param {BoundsTraverseOrderCallback} [callbacks.boundsTraverseOrder]
   * @returns {boolean}
   */
  shapecast(t) {
    const e = at.getPrimitive(), i = super.shapecast(
      {
        ...t,
        intersectsPrimitive: t.intersectsTriangle,
        scratchPrimitive: e,
        // TODO: is the performance significant enough for the added complexity here?
        // can we just use one function?
        iterate: this.indirect ? tr : Gn
      }
    );
    return at.releasePrimitive(e), i;
  }
  /**
   * A generalized cast function that traverses two BVH structures simultaneously to perform
   * intersection tests between them. This is used internally by `intersectsGeometry`. The
   * function returns `true` as soon as a triangle pair has been reported as intersected by
   * the callbacks.
   *
   * `matrixToLocal` is a Matrix4 that transforms `otherBvh` into the local space of this BVH.
   * The other BVH's triangles are transformed by this matrix before intersection tests.
   *
   * @param {MeshBVH} otherBvh
   * @param {Matrix4} matrixToLocal - Transforms `otherBvh` into the local space of this BVH.
   * @param {Object} callbacks
   * @param {IntersectsRangesCallback} [callbacks.intersectsRanges]
   * @param {IntersectsTrianglesCallback} [callbacks.intersectsTriangles]
   * @returns {boolean}
   */
  bvhcast(t, e, i) {
    let {
      intersectsRanges: s,
      intersectsTriangles: n
    } = i;
    const r = at.getPrimitive(), a = this.geometry.index, o = this.geometry.attributes.position, c = this.indirect ? (y) => {
      const m = this.resolveTriangleIndex(y);
      q(r, m * 3, a, o);
    } : (y) => {
      q(r, y * 3, a, o);
    }, h = at.getPrimitive(), l = t.geometry.index, u = t.geometry.attributes.position, d = t.indirect ? (y) => {
      const m = t.resolveTriangleIndex(y);
      q(h, m * 3, l, u);
    } : (y) => {
      q(h, y * 3, l, u);
    };
    if (n) {
      if (!(t instanceof Ee))
        throw new Error('MeshBVH: "intersectsTriangles" callback can only be used with another MeshBVH.');
      const y = (m, z, b, p, w, x, g, B) => {
        for (let _ = b, M = b + p; _ < M; _++) {
          d(_), h.a.applyMatrix4(e), h.b.applyMatrix4(e), h.c.applyMatrix4(e), h.needsUpdate = !0;
          for (let P = m, A = m + z; P < A; P++)
            if (c(P), r.needsUpdate = !0, n(r, h, P, _, w, x, g, B))
              return !0;
        }
        return !1;
      };
      if (s) {
        const m = s;
        s = function(z, b, p, w, x, g, B, _) {
          return m(z, b, p, w, x, g, B, _) ? !0 : y(z, b, p, w, x, g, B, _);
        };
      } else
        s = y;
    }
    return super.bvhcast(t, e, { intersectsRanges: s });
  }
  /* Derived Cast Functions */
  /**
   * Returns whether or not the mesh intersects the given box.
   *
   * The `boxToBvh` parameter is the transform of the box in the meshes frame.
   *
   * @param {Box3} box
   * @param {Matrix4} boxToBvh - Transform of the box in the local space of this BVH.
   * @returns {boolean}
   */
  intersectsBox(t, e) {
    return si.set(t.min, t.max, e), si.needsUpdate = !0, this.shapecast(
      {
        intersectsBounds: (i) => si.intersectsBox(i),
        intersectsTriangle: (i) => si.intersectsTriangle(i)
      }
    );
  }
  /**
   * Returns whether or not the mesh intersects the given sphere.
   *
   * @param {Sphere} sphere
   * @returns {boolean}
   */
  intersectsSphere(t) {
    return this.shapecast(
      {
        intersectsBounds: (e) => t.intersectsBox(e),
        intersectsTriangle: (e) => e.intersectsSphere(t)
      }
    );
  }
  /**
   * Computes the closest distance from the geometry to the mesh and puts the closest point on
   * the mesh in `target1` (in the frame of the BVH) and the closest point on the other
   * geometry in `target2` (in the geometry frame). If `target1` is not provided a new Object
   * is created and returned from the function.
   *
   * The `geometryToBvh` parameter is the transform of the geometry in the BVH's local frame.
   *
   * If a point is found that is closer than `minThreshold` then the function will return that
   * result early. Any triangles or points outside of `maxThreshold` are ignored. If no point
   * is found within the min / max thresholds then `null` is returned and the target objects
   * are not modified.
   *
   * The returned faceIndex in `target1` and `target2` can be used with the standalone function
   * `getTriangleHitPointInfo` to obtain more information like UV coordinates, triangle normal
   * and materialIndex.
   *
   * _Note that this function can be very slow if `geometry` does not have a
   * `geometry.boundsTree` computed._
   *
   * @param {BufferGeometry} otherGeometry
   * @param {Matrix4} geometryToBvh - Transform of `otherGeometry` into the local space of
   *   this BVH.
   * @param {HitPointInfo} [target1={}]
   * @param {HitPointInfo} [target2={}]
   * @param {number} [minThreshold=0]
   * @param {number} [maxThreshold=Infinity]
   * @returns {HitPointInfo|null}
   */
  closestPointToGeometry(t, e, i = {}, s = {}, n = 0, r = 1 / 0) {
    return (this.indirect ? wr : hr)(
      this,
      t,
      e,
      i,
      s,
      n,
      r
    );
  }
  /**
   * Computes the closest distance from the point to the mesh and gives additional information
   * in `target`. The target can be left undefined to default to a new object which is
   * ultimately returned by the function.
   *
   * If a point is found that is closer than `minThreshold` then the function will return that
   * result early. Any triangles or points outside of `maxThreshold` are ignored. If no point
   * is found within the min / max thresholds then `null` is returned and the `target` object
   * is not modified.
   *
   * The returned faceIndex can be used with the standalone function `getTriangleHitPointInfo`
   * to obtain more information like UV coordinates, triangle normal and materialIndex.
   *
   * @param {Vector3} point
   * @param {HitPointInfo} [target={}]
   * @param {number} [minThreshold=0]
   * @param {number} [maxThreshold=Infinity]
   * @returns {HitPointInfo|null}
   */
  closestPointToPoint(t, e = {}, i = 0, s = 1 / 0) {
    return Yn(
      this,
      t,
      e,
      i,
      s
    );
  }
}
const br = { indirect: !0, targetLeafSize: 10, verbose: !1 };
function zr(f, t) {
  const e = new ss();
  e.setAttribute("position", new mt(f, 3)), e.setIndex(new mt(t, 1));
  const i = new Ee(e, br), s = Ee.serialize(i, { cloneBuffers: !1 });
  if (!s.indirectBuffer) throw new Error("BVH: expected an indirect build");
  return { roots: s.roots, indirect: s.indirectBuffer };
}
const Yi = self;
Yi.onmessage = (f) => {
  const { id: t, positions: e, indices: i } = f.data, s = performance.now();
  try {
    const n = zr(e, i), r = { id: t, ok: !0, roots: n.roots, indirect: n.indirect, ms: performance.now() - s };
    Yi.postMessage(r, [...n.roots, n.indirect.buffer]);
  } catch (n) {
    Yi.postMessage({ id: t, ok: !1, error: n instanceof Error ? n.message : String(n) }, []);
  }
};
