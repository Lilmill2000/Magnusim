//-----------------------------------------------------------------------------
// Created on: 01 October 2018
//-----------------------------------------------------------------------------
// Copyright (c) 2018-present, Sergey Slyadnev
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

#ifndef asiAlgo_AttrBlendCandidate_h
#define asiAlgo_AttrBlendCandidate_h

// asiAlgo includes
#include <asiAlgo_BlendType.h>
#include <asiAlgo_BlendVexity.h>
#include <asiAlgo_FeatureAttrFace.h>

// Active Data includes
#include <ActAPI_IPlotter.h>

// Standard includes
#include <set>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Attribute to mark a face as a blend candidate.
class asiAlgo_AttrBlendCandidate : public asiAlgo_FeatureAttrFace
{
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_AttrBlendCandidate, asiAlgo_FeatureAttrFace)

public:

  //! Creates attribute with feature ID.
  //! \param[in] featureId 1-based feature ID.
  asiAlgo_AttrBlendCandidate(const int featureId)
  //
  : asiAlgo_FeatureAttrFace (featureId),
    Kind                    (BlendType_Uncertain),
    Length                  (0.),
    CrossLength             (0.),
    Confirmed               (false)
  {}

public:

  //! \return static GUID associated with this type of attribute.
  static const Standard_GUID& GUID()
  {
    static Standard_GUID guid("7B7C2DD0-5BD6-429E-9B71-5F935BF1E815");
    return guid;
  }

  //! \return GUID associated with this type of attribute.
  virtual const Standard_GUID& GetGUID() const override
  {
    return GUID();
  }

  //! \return human-readable name of the attribute.
  virtual const char* GetName() const override
  {
    return "blend candidate";
  }

public:

  //! Sets the only radius to store.
  //! \param[in] r the value to store.
  asiAlgo_EXPORT void
    SetRadius(const double r);

  //! \return max radius among the stored radii.
  asiAlgo_EXPORT double
    GetMaxRadius() const;

public:

  //! \return brief dump.
  asiAlgo_EXPORT virtual TCollection_AsciiString
    DumpInline() const;

  //! Dumps this attribute to the passed output stream.
  //! \param[in, out] target stream.
  asiAlgo_EXPORT virtual void
    Dump(Standard_OStream& out) const;

  //! Dumps this attribute to the passed plotter.
  //! \param[in,out] imperative plotter.
  asiAlgo_EXPORT virtual void
    DumpGraphically(ActAPI_PlotterEntry plotter) const;

protected:

  //! Dumps the custome attribute properties to JSON.
  //! \param[in,out] out       target output stream.
  //! \param[in]     numSpaces number of spaces to use for formatting.
  virtual void dumpJSON(Standard_OStream& out,
                        const int         numSpaces = 0) const
  {
    std::string ws; // whitespace.
    for ( int k = 0; k < numSpaces; ++k ) ws += " ";

    out << ",\n" << ws.c_str() << "\"kind\": "                << asiAlgo_Utils::Str::Quoted( kindToString(this->Kind) );
    out << ",\n" << ws.c_str() << "\"vexity\": "              << vexitiesToString(this->Vexities);
    out << ",\n" << ws.c_str() << "\"confirmed\": "           << (this->Confirmed ? "true" : "false");
    out << ",\n" << ws.c_str() << "\"numSmoothEdges\": "      << this->SmoothEdgeIndices.Extent();
    out << ",\n" << ws.c_str() << "\"numSpringEdges\": "      << this->SpringEdgeIndices.Extent();
    out << ",\n" << ws.c_str() << "\"numCrossEdges\": "       << this->CrossEdgeIndices.Extent();
    out << ",\n" << ws.c_str() << "\"numTerminatingEdges\": " << this->TerminatingEdgeIndices.Extent();
    out << ",\n" << ws.c_str() << "\"length\": "              << this->Length;
    out << ",\n" << ws.c_str() << "\"radii\": "               << asiAlgo_Utils::Json::FromIterable< std::set<double> >(this->Radii);
  }

  //! Converts blend kind enum to string.
  //! \param[in] kind blend kind in question.
  //! \return string representation of a blend kind.
  static std::string kindToString(const asiAlgo_BlendType kind)
  {
    switch ( kind )
    {
      case BlendType_Uncertain: return "uncertain";
      case BlendType_Ordinary:  return "ordinary";
      case BlendType_Vertex:    return "vertex";
      case BlendType_Cliff:     return "cliff";
      default: break;
    }

    return "undefined";
  }

  //! Converts blend vexity enum to string.
  //! \param[in] vx blend vexity in question.
  //! \return string representation of a blend vexity.
  static std::string vexityToString(const asiAlgo_BlendVexity vx)
  {
    switch ( vx )
    {
      case BlendVexity_Uncertain: return "uncertain";
      case BlendVexity_Concave:   return "concave";
      case BlendVexity_Convex:    return "convex";
      default: break;
    }

    return "undefined";
  }

  //! Converts the passed blend vexities to string.
  //! \param[in] vexities blend vexities in question.
  //! \return string representation of a blend vexity.
  static std::string
    vexitiesToString(const std::vector<asiAlgo_BlendVexity>& vexities)
  {
    std::stringstream out;

    out << "[";
    if ( !vexities.empty() )
    {
      auto it = vexities.begin();
      //
      out << asiAlgo_Utils::Str::Quoted( vexityToString(*it) );
      //
      it++;

      for ( auto end = vexities.end(); it != end; ++it )
      {
        out << ", " << asiAlgo_Utils::Str::Quoted( vexityToString(*it) );
      }
    }
    out << "]";

    return out.str();
  }

public:

  asiAlgo_BlendType                Kind;                   //!< Blend type.
  std::vector<asiAlgo_BlendVexity> Vexities;               //!< Blend vexity (several for VBFs).
  std::set<double>                 Radii;                  //!< Blend radius or perhaps several radii for VBFs.
  double                           Length;                 //!< Blend length.
  double                           CrossLength;            //!< Cross-edge length.
  bool                             Confirmed;              //!< Confirmed/unconfirmed blend.
  TColStd_PackedMapOfInteger       SmoothEdgeIndices;      //!< Smooth edges.
  TColStd_PackedMapOfInteger       SpringEdgeIndices;      //!< Spring edges.
  TColStd_PackedMapOfInteger       CrossEdgeIndices;       //!< Cross edges.
  TColStd_PackedMapOfInteger       TerminatingEdgeIndices; //!< Sharp terminating edges.

};

#endif
