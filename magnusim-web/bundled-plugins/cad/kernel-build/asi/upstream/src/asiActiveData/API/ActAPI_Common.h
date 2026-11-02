//-----------------------------------------------------------------------------
// Created on: April 2012
//-----------------------------------------------------------------------------
// Copyright (c) 2017, OPEN CASCADE SAS
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
//    * Neither the name of OPEN CASCADE SAS nor the
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
//
// Web: http://analysissitus.org
//-----------------------------------------------------------------------------

#ifndef ActAPI_Common_HeaderFile
#define ActAPI_Common_HeaderFile

// Active Data (API) includes
#include <ActData.h>

// OCCT includes
#include <gp_XYZ.hxx>
#include <NCollection_Array1.hxx>
#include <NCollection_Array2.hxx>
#include <NCollection_DataMap.hxx>
#include <NCollection_HArray1.hxx>
#include <NCollection_HArray2.hxx>
#include <NCollection_Sequence.hxx>
#include <NCollection_Shared.hxx>
#include <Standard_GUID.hxx>
#include <Standard_ProgramError.hxx>
#include <TCollection_AsciiString.hxx>
#include <TColStd_HArray1OfBoolean.hxx>
#include <TColStd_HArray1OfExtendedString.hxx>
#include <TColStd_HArray1OfInteger.hxx>
#include <TColStd_HArray1OfReal.hxx>
#include <TColStd_HArray2OfBoolean.hxx>
#include <TColStd_HArray2OfInteger.hxx>
#include <TColStd_HArray2OfReal.hxx>
#include <TColStd_PackedMapOfInteger.hxx>
#include <TopoDS_Shape.hxx>

//-----------------------------------------------------------------------------
// Assertions
//-----------------------------------------------------------------------------

#define ASSERT(expr, todo) \
  {  \
    if ( ! (expr) ) \
    { \
      todo; \
    } \
  }

#define ASSERT_RAISE(expr, mess) \
  ASSERT(expr, Standard_ProgramError::Raise( \
      "*** ERROR: ASSERT in file " __FILE__ ": \n" mess " (" #expr ")" ) )

typedef TCollection_AsciiString    t_asciiString;
typedef TCollection_ExtendedString t_extString;
typedef TColStd_PackedMapOfInteger t_packedMap;

//! \ingroup AD_DF
//!
//! Complex number.
struct ComplexNumber
{
  Standard_Real Re; //!< Real part.
  Standard_Real Im; //!< Imaginary part.

  //! Creates complex number from amplitude and phase.
  //! \param Amp     [in] amplitude.
  //! \param Phi_rad [in] phase.
  static ComplexNumber FromEuler(const Standard_Real Amp,
                                 const Standard_Real Phi_rad)
  {
    return ComplexNumber( Amp*Cos(Phi_rad), Amp*Sin(Phi_rad) );
  }

  //! Default constructor.
  ComplexNumber() : Re(0.0), Im(0.0)
  {}

  //! Complete constructor.
  //! \param theReal      [in] real part.
  //! \param theImaginary [in] imaginary part.
  ComplexNumber(const Standard_Real theReal,
                const Standard_Real theImaginary)
  : Re(theReal), Im(theImaginary)
  {}

  //! Multiplication operator.
  //! \param k [in] value to multiply to.
  //! \return new complex number.
  ComplexNumber operator*(const Standard_Real k) const
  {
    ComplexNumber c(*this);
    c.Re *= k;
    c.Im *= k;
    return c;
  }

  //! Adds the passed complex number to the given one.
  //! \param cVal [in] complex number to add.
  //! \return resulting complex number.
  ComplexNumber operator+(const ComplexNumber& cVal) const
  {
    ComplexNumber c(*this);
    c.Re += cVal.Re;
    c.Im += cVal.Im;
    return c;
  }

  //! Adds the passed complex number to the current one.
  //! \param cVal [in] complex number to add.
  //! \return resulting complex number.
  ComplexNumber& operator+=(const ComplexNumber& cVal)
  {
    this->Re += cVal.Re;
    this->Im += cVal.Im;
    return *this;
  }

  //! Subtracts the passed number from the given one.
  //! \param cVal [in] value to subtract.
  //! \return resulting complex number.
  ComplexNumber operator-(const ComplexNumber& cVal) const
  {
    ComplexNumber c(*this);
    c.Re -= cVal.Re;
    c.Im -= cVal.Im;
    return c;
  }

  //! Adds the passed complex number to the current one.
  //! \param cVal [in] complex number to add.
  //! \return resulting complex number.
  ComplexNumber& operator-=(const ComplexNumber& cVal)
  {
    this->Re -= cVal.Re;
    this->Im -= cVal.Im;
    return *this;
  }

  //! Returns squared amplitude.
  //! \return squared amplitude.
  Standard_Real Amp2() const
  {
    return Square(this->Re) + Square(this->Im);
  }

  //! Returns amplitude.
  //! \return amplitude.
  Standard_Real Amp() const
  {
    return Sqrt( this->Amp2() );
  }

  //! Returns phase.
  //! \return phase.
  Standard_Real Phi() const
  {
    return atan2(Im, Re);
  }

};

//! \ingroup AD_DF
//!
//! Shortcut for one-dimensional static array of complex numbers.
typedef NCollection_Array1<ComplexNumber> ComplexArray;
NCOLLECTION_HARRAY1(HComplexArray, ComplexNumber)

//! \ingroup AD_DF
//!
//! Shortcut for two-dimensional static array of complex numbers.
typedef NCollection_Array2<ComplexNumber> ComplexMatrix;
NCOLLECTION_HARRAY2(HComplexMatrix, ComplexNumber)

//! \ingroup AD_DF
//!
//! Shortcut for one-dimensional static array of OCCT shapes.
typedef NCollection_Array1<TopoDS_Shape> ShapeArray;
NCOLLECTION_HARRAY1(HShapeArray, TopoDS_Shape)

//! \ingroup AD_DF
//!
//! Shortcut for one-dimensional static array of integers.
typedef TColStd_Array1OfInteger  IntArray;
typedef TColStd_HArray1OfInteger HIntArray;

//! \ingroup AD_DF
//!
//! Shortcut for two-dimensional static array of integers.
typedef TColStd_Array2OfInteger  IntMatrix;
typedef TColStd_HArray2OfInteger HIntMatrix;

//! \ingroup AD_DF
//!
//! Shortcut for one-dimensional static array of reals.
typedef TColStd_Array1OfReal  RealArray;
typedef TColStd_HArray1OfReal HRealArray;

//! \ingroup AD_DF
//!
//! Shortcut for two-dimensional static array of reals.
typedef TColStd_Array2OfReal  RealMatrix;
typedef TColStd_HArray2OfReal HRealMatrix;

//! \ingroup AD_DF
//!
//! Shortcut for one-dimensional static array of Booleans.
typedef TColStd_Array1OfBoolean  BoolArray;
typedef TColStd_HArray1OfBoolean HBoolArray;

//! \ingroup AD_DF
//!
//! Shortcut for two-dimensional static array of Booleans.
typedef TColStd_Array2OfBoolean  BoolMatrix;
typedef TColStd_HArray2OfBoolean HBoolMatrix;

//! \ingroup AD_DF
//!
//! Shortcut for one-dimensional static array of strings.
typedef TColStd_Array1OfExtendedString  StringArray;
typedef TColStd_HArray1OfExtendedString HStringArray;

//! \ingroup AD_DF
//!
//! Shortcut for two-dimensional static array of strings.
typedef NCollection_Array2<TCollection_ExtendedString> StringMatrix;
NCOLLECTION_HARRAY2(HStringMatrix, TCollection_ExtendedString)

//! \ingroup AD_DF
//!
//! Shortcut for dynamic ordered direct-access collection of 3D points.
typedef NCollection_Sequence<gp_XYZ>  PointList;
typedef NCollection_Shared<PointList> HPointList;

//! \ingroup AD_DF
//!
//! Shortcut for dynamic ordered direct-access collection of ASCII strings.
typedef NCollection_Sequence<TCollection_AsciiString> StringList;
typedef NCollection_Shared<StringList>                HStringList;

//! \ingroup AD_DF
//!
//! Global namespace.
namespace ActiveData
{
  //! \ingroup AD_DF
  //!
  //! Hasher for GUIDs.
  struct GuidHasher
  {
    //! Global HashCode function to be used in OCCT Data Maps.
    //! \param theGuid [in] GUID to calculate a hash code for.
    //! \param theUpper [in] upper index.
    //! \return hash code.
    static Standard_Integer HashCode(const Standard_GUID& theGuid,
                                     const Standard_Integer theUpper)
    {
      return Standard_GUID::HashCode(theGuid, theUpper);
    }

    //! Check equality of the two passed GUIDs.
    //! \param[in] theGuid1 GUID 1.
    //! \param[in] theGuid2 GUID 2.
    //! \return true in case of equality.
    static Standard_Boolean IsEqual(const Standard_GUID& theGuid1,
                                    const Standard_GUID& theGuid2)
    {
      return Standard_GUID::IsEqual(theGuid1, theGuid2);
    }
  };
} // ActiveData namespace.

//! \ingroup AD_DF
//!
//! Mapping between integers.
typedef NCollection_DataMap<Standard_Integer, Standard_Integer> IntIntMap;

//! \ingroup AD_DF
//!
//! Mapping between integers and reals.
typedef NCollection_DataMap<Standard_Integer, Standard_Real> IntRealMap;

#endif
