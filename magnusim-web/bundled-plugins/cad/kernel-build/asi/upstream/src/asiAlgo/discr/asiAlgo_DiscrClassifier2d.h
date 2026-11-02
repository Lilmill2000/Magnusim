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

#ifndef asiAlgo_DiscrClassifier2d_HeaderFile
#define asiAlgo_DiscrClassifier2d_HeaderFile

// asiAlgo includes
#include <asiAlgo_DiscrFace.h>
#include <asiAlgo_DiscrLocation.h>
#include <asiAlgo_DiscrSegAddress.h>

// OpenCascade includes
#include <Standard_Transient.hxx>
#include <Standard_Type.hxx>
#include <NCollection_List.hxx>
#include <NCollection_Vector.hxx>
#include <NCollection_Sequence.hxx>
#include <gp_Pnt2d.hxx>

//-----------------------------------------------------------------------------

//! \ingroup ASI_CORE
//!
namespace asiAlgo {
namespace discr {

//! Classifies a two-dimensional point as IN, ON and OUT of the parametric
//! boundary of the given discrete face.
//!
//! On initialization, all segments of the face frontiers are stored in the rows
//! oriented along X or Y. To check membership of a point, we count the number
//! of intersections between the boundary segments and a ray directed to positive
//! infinity along its row (even number of intersections is OUT, otherwise IN).
//! The partition of R2 into rows allows time saving by examining only those
//! segments that have a part in a row where the point lies. The partitioned
//! coordinate is called 'abscissa' and the coordinate parallel to the casted
//! ray is the 'ordinate'.
//!
//! One important property of this classifier compared to, for example, Haines,
//! is that it can also give the ON status. A point is classified as ON if it
//! lies within a tolerance of a segment.
//!
//! The constructor takes as parameters a discrete face object and the tolerance
//! value. The default tolerance is guessed to be much smaller than the mean length
//! of segments.
class Classifier2d : public Standard_Transient
{
  // OpenCascade RTTI
  DEFINE_STANDARD_RTTI_INLINE(Classifier2d, Standard_Transient)

public:

  // Options to emit a ray.
  typedef enum {
    AlongX,
    AlongY
  } RayDirection;

private:

  class ClassifierRow
  {
    friend class Classifier2d;
  public:

    //! This class describes a segment in R2 of abscissa and ordinate (see definition
    //! above) oriented along abscissa coded by starting point (A1,O1), maximum
    //! abscissa value A2 and the direction ort (DA,DO).
    class ClassifierSeg
    {
    public:
      ClassifierSeg() {}
      ClassifierSeg(const gp_Pnt2d&    P1,
                    const gp_Pnt2d&    P2,
                    const RayDirection Dir,
                    const SegAddress&  Source);

      double            AMin      () const { return myA1; }
      double            AMax      () const { return myA2; }
      double            A1        () const { return myA1; }
      double            O1        () const { return myO1; }
      double            A2        () const { return myA2; }
      double            O2        () const { return myO2; }
      double            DA        () const { return myDA; }
      double            DO        () const { return myDO; }
      const SegAddress& Source    () const { return mySource; }
      bool              IsForward () const { return myIsForward; }

    private:

      double      myA1, myO1;
      double      myA2, myO2;
      double      myDA, myDO;
      SegAddress  mySource;
      bool        myIsForward;
    };

  // methods of ClassifierRow
  public:
    // Empty constructor for array creation
    ClassifierRow() {}

    // Constructor
    // \param[in] Dir          row oriention.
    // \param[in] MemAllocator optional memory allocator.
    ClassifierRow(const RayDirection                       Dir,
                  const Handle(NCollection_BaseAllocator)& MemAllocator = 0L)
    : myDir      (Dir),
      mySegments (MemAllocator)
    {}

    // New segment addition - it must fall into this row
    void AddSegment (const ClassifierSeg& seg)
    {
      mySegments.Append(&seg);
    }

    // Point location about the row segments
    // Taking into account that segments are in abscissa-ordinate space, let
    // the points be in those coordinates too.
    // Outputs the address of the NEAREST source segment (theSrc).
    // Additionally, if the result is asiAlgo_DiscrON outputs the real distance (theTol).
    // theWireIndex designates the contour, whose segments are considered;
    // 0 means all the contours
    Location Locate(const gp_Pnt2d& thePnt,
                    double&         theTol,
                    SegAddress&     theSrc,
                    double&         thePar,
                    const int       theWireIndex) const;

  private:
    // fields
    RayDirection                            myDir;
    NCollection_List<const ClassifierSeg *> mySegments;
  };

  // A helper class needed during algorithm construction
  class ClsSeg
  {
    gp_Pnt2d   myPnt[2];
    SegAddress mySource;
  public:
    ClsSeg () {}
    ClsSeg (const gp_Pnt2d& theP1, const gp_Pnt2d& theP2,
            const SegAddress& theSource)
      : mySource (theSource)
      {
        myPnt[0] = theP1;
        myPnt[1] = theP2;
      }
    const gp_Pnt2d&  Point  (const int i) const { return myPnt[i]; }
    const SegAddress& Source ()             const { return mySource; }
  };

 public:
  // ---------- PUBLIC METHODS ----------

  // Constructor
  // - theFace is a face
  // - theTol is a tolerance for ON check
  //   (by default is negative, then it is computed within as 1% of row width)
  asiAlgo_EXPORT Classifier2d(const Face&  theFace,
                              const double theTol=-1.);
  // Constructor
  // the boundary is defined by the list of points
  asiAlgo_EXPORT Classifier2d(NCollection_List<gp_Pnt2d> thePList,
                              const double               theTol=-1.);

  ~Classifier2d()
  {
    if (myRows) delete [] myRows;
  }

  // Query the tolerance value
  double Tolerance() const { return myTol; }

  // Point location about the face in IN/ON/OUT classes.
  // theWireIndex designates the contour, whose segments are considered;
  // 0 means all the contours
  inline          Location Locate (const gp_Pnt2d& thePnt,
                                   const int theWireIndex=0) const;

  // Point location about the face in ON, IN and OUT classes
  // Regardless of resulting position outputs address of the nearest segment theSource.
  // If ON, outputs the distance theDist to the nearest segment
  // ON condition is tested with respect to the tolerance given in constructor
  asiAlgo_EXPORT Location Locate (const gp_Pnt2d& thePnt,
                                  double&         theDist,
                                  SegAddress&     theSource,
                                  double&         theParam,
                                  const int       theWireIndex = 0) const;

  // Locates the 2d box about the face:
  // returns true if there are no segments or their parts inside the box
  // or on boundary of the box. There is presumption that all 4 corners
  // of the box have position OUT.
  asiAlgo_EXPORT bool IsOut (const gp_Pnt2d& theLoLeft,
                             const gp_Pnt2d& theUpRite);

 private:
  // ---------- PRIVATE METHODS ----------
  void completeConstruction
                    (const NCollection_List<ClsSeg>& theBulk,
                     const double theXMin, const double theXMax,
                     const double theTotXSpan,
                     const double theYMin, const double theYMax,
                     const double theTotYSpan,
                     const int theSlopeX);

  // ---------- PRIVATE (PROHIBITED) METHODS ----------
  // Copy constructor
  Classifier2d(const Classifier2d& theOther);

  // Assignment
  Classifier2d& operator=(const Classifier2d& theOther);

 private:
  // ---------- PRIVATE FIELDS ----------

  // myDirection is found automatically in the constructor
  // It shows along which of the axes we will orient the ray
  RayDirection                   myDirection;
  NCollection_Vector<ClassifierRow::ClassifierSeg>
                                        mySegments;

  // Rows contain segments to intersect with the ray
  ClassifierRow                         * myRows;
  int                      myNbRows;

  double                         myAMin;
  double                         myAMax;
  double                         myAStep;
  double                         myTol;

  // Memory allocator for NCollections
  Handle(NCollection_BaseAllocator) myMemAllocator;

};

//=======================================================================
//function : Locate
//purpose  : Point location about the face in IN/ON/OUT classes
//=======================================================================

inline Location Classifier2d::Locate
                                   (const gp_Pnt2d&        thePnt,
                                    const int theWireIndex) const
{
  double aDummyReal = -1.;
  SegAddress aDummySource;
  return Locate (thePnt, aDummyReal, aDummySource, aDummyReal, theWireIndex);
}

}
}

#endif
