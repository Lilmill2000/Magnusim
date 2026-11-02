// asi_occt79_compat.h: force-included (-include) into every Analysis Situs source the kernel
// build compiles (build-asi.sh), and into nothing else. Analysis Situs v2026.1.1 targets
// OCCT 7.6; OCCT 7.8 replaced the "static HashCode(key, upper) / IsEqual(a, b)" hasher
// protocol with call operators and removed the global HashCode() helpers. This header
// restores the removed globals and gives a one-line macro that adds the 7.8+ call operators
// to an old-style hasher (asi-occt79-wasm.patch puts it into each hasher that needs it).
// Ours, not upstream code.
// SPDX-License-Identifier: GPL-3.0-or-later
#ifndef asi_occt79_compat_h
#define asi_occt79_compat_h

#include <functional>
#include <Standard_GUID.hxx>
#include <Standard_Integer.hxx>
#include <TCollection_AsciiString.hxx>
#include <TopoDS_Shape.hxx>

// Old global helpers (OCCT <= 7.7): hash in [1, upper].
inline Standard_Integer asiCompat_Cap(const size_t theHash, const Standard_Integer theUpper)
{
  return static_cast<Standard_Integer>((theHash & 0x7fffffff) % static_cast<size_t>(theUpper)) + 1;
}
inline Standard_Integer HashCode(const Standard_Integer theValue, const Standard_Integer theUpper)
{
  return asiCompat_Cap(static_cast<size_t>(static_cast<unsigned int>(theValue)), theUpper);
}
inline Standard_Integer HashCode(const void* thePtr, const Standard_Integer theUpper)
{
  return asiCompat_Cap(std::hash<const void*>{}(thePtr), theUpper);
}
inline Standard_Integer HashCode(const TCollection_AsciiString& theStr, const Standard_Integer theUpper)
{
  return asiCompat_Cap(theStr.HashCode(), theUpper);
}
inline Standard_Integer HashCode(const TopoDS_Shape& theShape, const Standard_Integer theUpper)
{
  return asiCompat_Cap(std::hash<TopoDS_Shape>{}(theShape), theUpper);
}
inline Standard_Integer HashCode(const Standard_GUID& theGuid, const Standard_Integer theUpper)
{
  return asiCompat_Cap(std::hash<Standard_GUID>{}(theGuid), theUpper);
}
inline Standard_Boolean IsEqual(const Standard_Integer theA, const Standard_Integer theB)
{
  return theA == theB;
}
// IsEqual(TCollection_AsciiString, TCollection_AsciiString) still exists in 7.9.
inline Standard_Boolean IsEqual(const TopoDS_Shape& theA, const TopoDS_Shape& theB)
{
  return theA.IsEqual(theB);
}
inline Standard_Boolean IsEqual(const Standard_GUID& theA, const Standard_GUID& theB)
{
  return theA == theB;
}

// Inside an old-style hasher struct/class: adds the OCCT 7.8+ protocol
// (size_t operator()(key) and bool operator()(key, key)) on top of its static
// HashCode(key, upper) / IsEqual(key, key).
#define ASI_OCCT78_HASHER(K)                                                   \
  using asiCompat_Key = K;                                                     \
  size_t operator()(const asiCompat_Key& theKey) const                         \
  {                                                                            \
    return static_cast<size_t>(HashCode(theKey, 2147483647));                  \
  }                                                                            \
  bool operator()(const asiCompat_Key& theKey1, const asiCompat_Key& theKey2) const \
  {                                                                            \
    return IsEqual(theKey1, theKey2) ? true : false;                           \
  }

#endif
