//-----------------------------------------------------------------------------
// Created on: 15 April 2022
//-----------------------------------------------------------------------------
// Copyright (c) 2022-present, Quaoar Studio LLC
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//    * Redistributions of source code must retain the above copyright
//      notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above copyright
//      notice, this list of conditions and the following disclaimer in the
//      documentation and/or other materials provided with the distribution.
//    * Neither the name of the copyright holder(s) nor the
//      names of all contributors may be used to endorse or promote products
//      derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//-----------------------------------------------------------------------------

#ifndef asiAlgo_DiscrSegAddress_HeaderFile
#define asiAlgo_DiscrSegAddress_HeaderFile

// asiAlgo includes
#include <asiAlgo.h>

// OpenCascade includes
#include <Standard_Integer.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_CORE
//!
namespace asiAlgo {
namespace discr {

// This class serves to contain the compound index of 
// a segment of boundary of a face
class SegAddress
{
 public:
  // ---------- PUBLIC METHODS ----------

  SegAddress ()
    : myWireIndex(0), myEdgeIndex(0),
      myCurveIndex(0), mySegmentIndex(0) {}
  // Empty constructor

  SegAddress (const int theWireIndex,
              const int theEdgeIndex,
              const int theCurveIndex,
              const int theSegmentIndex)
    : myWireIndex(theWireIndex), myEdgeIndex(theEdgeIndex),
      myCurveIndex(theCurveIndex), mySegmentIndex(theSegmentIndex) {}
  // Full constructor

  void Init (const int theWireIndex,
             const int theEdgeIndex,
             const int theCurveIndex,
             const int theSegmentIndex)
  { myWireIndex = theWireIndex; myEdgeIndex = theEdgeIndex;
    myCurveIndex = theCurveIndex; mySegmentIndex = theSegmentIndex; }
  // Initialize anew

  int WireIndex () const { return myWireIndex; }

  int EdgeIndex () const { return myEdgeIndex; }

  int CurveIndex () const { return myCurveIndex; }

  int SegmentIndex () const { return mySegmentIndex; }

  int& ChangeWireIndex () { return myWireIndex; }

  int& ChangeEdgeIndex () { return myEdgeIndex; }

  int& ChangeCurveIndex () { return myCurveIndex; }

  int& ChangeSegmentIndex () { return mySegmentIndex; }

  bool operator == (const SegAddress& theOther) const
        { return (myWireIndex    == theOther.myWireIndex &&
                  myEdgeIndex    == theOther.myEdgeIndex &&
                  myCurveIndex   == theOther.myCurveIndex &&
                  mySegmentIndex == theOther.mySegmentIndex);
        }

 private:
  // ---------- PRIVATE FIELDS ----------

  int myWireIndex;
  int myEdgeIndex;
  int myCurveIndex;
  int mySegmentIndex;

};

//! Computes a hash code for the given segment address of the face boundary, in the range [1, theUpperBound]
//! @param theSegmentAddress the given segment address of the face boundary which hash code is to be computed
//! @param theUpperBound the upper bound of the range a computing hash code must be within
//! @return a computed hash code, in the range [1, theUpperBound]
inline int HashCode(const SegAddress& theSegmentAddress,
                    const int       theUpperBound)
{
  return ::HashCode (((theSegmentAddress.WireIndex()    & 255)  + 1) *
                     ((theSegmentAddress.EdgeIndex()    & 255)  + 1) *
                     ((theSegmentAddress.SegmentIndex() & 1023) + 1) / 5, theUpperBound);
}

//=======================================================================
//function : IsEqual
//purpose  : used in maps
//=======================================================================

inline bool IsEqual(const SegAddress& aSeg1,
                    const SegAddress& aSeg2)
{
  return aSeg1 == aSeg2;
}

}
}

#endif
