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

// Own include
#include <asiAlgo_AttrBlendCandidate.h>

// asiAlgo includes
#include <asiAlgo_AAG.h>
#include <asiAlgo_Utils.h>

// OCCT includes
#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>

// Standard includes
#include <algorithm>

//-----------------------------------------------------------------------------

void asiAlgo_AttrBlendCandidate::SetRadius(const double r)
{
  this->Radii.clear();
  this->Radii.insert(r);
}

//-----------------------------------------------------------------------------

double asiAlgo_AttrBlendCandidate::GetMaxRadius() const
{
  return *std::max_element( this->Radii.cbegin(), this->Radii.cend() );
}

//-----------------------------------------------------------------------------

TCollection_AsciiString asiAlgo_AttrBlendCandidate::DumpInline() const
{
  TCollection_AsciiString lbl;

  // Compose a label.
  lbl += "confirmed: "; lbl += (this->Confirmed ? "true" : "false");
  //
  if ( this->Kind == BlendType_Uncertain )
    lbl += " / uncertain";
  else if ( this->Kind == BlendType_Ordinary )
    lbl += " / ordinary";
  else if ( this->Kind == BlendType_Vertex )
    lbl += " / vertex";
  else if ( this->Kind == BlendType_Cliff )
    lbl += " / cliff";
  //
  lbl += " / ";
  lbl += vexitiesToString(this->Vexities).c_str();
  //
  if ( this->SpringEdgeIndices.Extent() )
  {
    lbl += " / spring edges: ";
    lbl += asiAlgo_Utils::Json::FromFeature(this->SpringEdgeIndices).c_str();
  }
  //
  if ( this->CrossEdgeIndices.Extent() )
  {
    lbl += " / cross edges: ";
    lbl += asiAlgo_Utils::Json::FromFeature(this->CrossEdgeIndices).c_str();
  }
  //
  if ( this->TerminatingEdgeIndices.Extent() )
  {
    lbl += " / term edges: ";
    lbl += asiAlgo_Utils::Json::FromFeature(this->TerminatingEdgeIndices).c_str();
  }
  //
  if ( this->Radii.size() == 1 )
  {
    lbl += " / radius: "; lbl += *this->Radii.begin();
  }
  else if ( this->Radii.size() > 1 )
  {
    lbl += " / radii: [";

    size_t ii = 0;
    for ( auto r : this->Radii )
    {
      lbl += r;

      if ( ++ii < this->Radii.size() ) lbl += ", ";
    }

    lbl += "]";
  }
  //
  lbl += " / length: "; lbl += this->Length;

  return lbl;
}

//-----------------------------------------------------------------------------

void asiAlgo_AttrBlendCandidate::Dump(Standard_OStream& out) const
{
  out << "\n\t" << this->DynamicType()->Name();
  out << "\n\tFeature ID: " << this->GetFeatureId();
  out << "\n\tType: ";
  //
  if ( this->Kind == BlendType_Uncertain )
    out << "uncertain";
  else if ( this->Kind == BlendType_Ordinary )
    out << "ordinary";
  else if ( this->Kind == BlendType_Vertex )
    out << "vertex";
  else if ( this->Kind == BlendType_Cliff )
    out << "cliff";
  //
  out << "\n\tVexity: ";
  out << vexitiesToString(this->Vexities);

  out << "\n\tConfirmed: "              << (this->Confirmed ? "true" : "false");
  out << "\n\tNum. smooth edges: "      <<  this->SmoothEdgeIndices.Extent();
  out << "\n\tNum. spring edges: "      <<  this->SpringEdgeIndices.Extent();
  out << "\n\tNum. cross edges: "       <<  this->CrossEdgeIndices.Extent();
  out << "\n\tNum. terminating edges: " <<  this->TerminatingEdgeIndices.Extent();
}

//-----------------------------------------------------------------------------

void asiAlgo_AttrBlendCandidate::DumpGraphically(ActAPI_PlotterEntry plotter) const
{
  asiAlgo_AAG* pAAG = this->getAAG();
  const int    fid  = this->GetFaceId();
  //
  if ( !pAAG || !pAAG->HasFace(fid) )
    return;

  // Dump the face.
  plotter.DRAW_SHAPE( pAAG->GetFace(fid),
                      this->Kind == BlendType_Ordinary ? Color_Blue : Color_Magenta,
                      "DUMP blend" );

  // Get map of edges.
  const TopTools_IndexedMapOfShape& allEdges = pAAG->RequestMapOfEdges();

  // Draw spring edges.
  for ( TColStd_MapIteratorOfPackedMapOfInteger mit(this->SpringEdgeIndices);
        mit.More(); mit.Next() )
  {
    plotter.DRAW_SHAPE( allEdges.FindKey( mit.Key() ),
                        ActAPI_Color(0., 150./255., 240./255., Quantity_TOC_RGB),
                        1.0, true, "DUMP spring edge" );
  }

  // Draw cross edges.
  for ( TColStd_MapIteratorOfPackedMapOfInteger mit(this->CrossEdgeIndices);
        mit.More(); mit.Next() )
  {
    plotter.DRAW_SHAPE( allEdges.FindKey( mit.Key() ),
                                          ActAPI_Color(230./255, 10./255, 10./255., Quantity_TOC_RGB),
                                          1.0, true, "DUMP cross edge" );
  }

  // Draw terminating edges.
  for ( TColStd_MapIteratorOfPackedMapOfInteger mit(this->TerminatingEdgeIndices);
        mit.More(); mit.Next() )
  {
    plotter.DRAW_SHAPE( allEdges.FindKey( mit.Key() ),
                        ActAPI_Color(220./255., 0., 220./255., Quantity_TOC_RGB),
                        1.0, true, "DUMP terminating edge" );
  }
}
