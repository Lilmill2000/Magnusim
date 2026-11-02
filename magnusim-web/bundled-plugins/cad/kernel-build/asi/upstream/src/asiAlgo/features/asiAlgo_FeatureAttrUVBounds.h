//-----------------------------------------------------------------------------
// Created on: 08 April 2022
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

#ifndef asiAlgo_FeatureAttrUVBounds_h
#define asiAlgo_FeatureAttrUVBounds_h

// asiAlgo includes
#include <asiAlgo.h>

// asiAlgo includes
#include <asiAlgo_FeatureAttrFace.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! AAG attribute to store UV bounds of a face.
class asiAlgo_FeatureAttrUVBounds : public asiAlgo_FeatureAttr
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_FeatureAttrUVBounds, asiAlgo_FeatureAttr)

public:

  //! Ctor.
  asiAlgo_FeatureAttrUVBounds()
  //
  : asiAlgo_FeatureAttr (),
    uMin                (0.),
    uMax                (0.),
    vMin                (0.),
    vMax                (0.)
  {}

  //! Complete ctor.
  asiAlgo_FeatureAttrUVBounds(const double _uMin,
                              const double _uMax,
                              const double _vMin,
                              const double _vMax)
  : asiAlgo_FeatureAttr (),
    uMin                (_uMin),
    uMax                (_uMax),
    vMin                (_vMin),
    vMax                (_vMax)
  {}

  //! \return static GUID associated with this type of attribute.
  static const Standard_GUID& GUID()
  {
    static Standard_GUID guid("CE845C1C-B945-4777-9379-5254E2AAB3FE");
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
    return "UV bounds";
  }

protected:

  //! Dumps extra props to JSON.
  virtual void dumpJSON(Standard_OStream& out,
                        const int         indent) const
  {
    std::string ws(indent, ' ');
    std::string nl = "\n" + ws;

    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Umin) << ": " << uMin;
    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Umax) << ": " << uMax;
    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Vmin) << ": " << vMin;
    out << "," << nl << asiAlgo_Utils::Str::Quoted(asiPropName_Vmax) << ": " << vMax;
  }

public:

  double uMin, uMax, vMin, vMax;

};

#endif
