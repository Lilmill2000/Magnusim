//-----------------------------------------------------------------------------
// Created on: 19 October 2023
//-----------------------------------------------------------------------------
// Copyright (c) 2023, Sergey Slyadnev
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

#ifndef asiAlgo_FeatureAttrAxialRange_h
#define asiAlgo_FeatureAttrAxialRange_h

// asiAlgo includes
#include <asiAlgo_FeatureAttrFace.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Axial range of the face as its projection to the axis stored in
//! this same attribute.
class asiAlgo_FeatureAttrAxialRange : public asiAlgo_FeatureAttr
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_FeatureAttrAxialRange, asiAlgo_FeatureAttr)

public:

  //! Ctor.
  asiAlgo_FeatureAttrAxialRange()
  : asiAlgo_FeatureAttr (),
    hMin                (0),
    hMax                (0)
  {}

  //! Ctor with range bounds.
  asiAlgo_FeatureAttrAxialRange(const double h1,
                                const double h2)
  : asiAlgo_FeatureAttr (),
    hMin                (h1),
    hMax                (h2)
  {}

  //! \return static GUID associated with this type of attribute.
  static const Standard_GUID& GUID()
  {
    static Standard_GUID guid("B9CB23DC-80D0-4FC5-9996-93D672944928");
    return guid;
  }

  //! \return GUID associated with this type of attribute.
  virtual const Standard_GUID& GetGUID() const override
  {
    return GUID();
  }

  //! \return human-friendly name of the attribute.
  virtual const char* GetName() const override
  {
    return "Axial range";
  }

protected:

  //! Dumps extra props to JSON.
  virtual void dumpJSON(Standard_OStream& out,
                        const int         indent) const
  {
    std::string ws(indent, ' ');
    std::string nl = "\n" + ws;

    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Hmin) << ": " << hMin;
    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Hmax) << ": " << hMin;
  }

public:

  double hMin; //!< Left bound of the range.
  double hMax; //!< Right bound of the range.

};

#endif
