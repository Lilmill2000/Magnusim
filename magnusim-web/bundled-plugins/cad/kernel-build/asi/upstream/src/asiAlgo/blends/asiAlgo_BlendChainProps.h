//-----------------------------------------------------------------------------
// Created on: 26 April 2021
//-----------------------------------------------------------------------------
// Copyright (c) 2021-present, Sergey Slyadnev
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

#ifndef asiAlgo_BlendChainProps_h
#define asiAlgo_BlendChainProps_h

// asiAlgo includes
#include <asiAlgo.h>

//-----------------------------------------------------------------------------

//! \ingroup ASI_AFR
//!
//! Fillet chain properties.
struct asiAlgo_BlendChainProps
{
  double Length;          //!< Chain total length.
  double Radius;          //!< Blending radius.
  double CrossEdgeLength; //!< Cross-edge length.

  //! Default ctor.
  asiAlgo_BlendChainProps()
  : Length          (0.),
    Radius          (0.),
    CrossEdgeLength (0.)
  {}

  //! Ctor.
  //! \param[in] len the length to set.
  //! \param[in] r   the radius to set.
  asiAlgo_BlendChainProps(const double len,
                          const double r)
  : Length          (len),
    Radius          (r),
    CrossEdgeLength (0.)
  {}

  //! Complete ctor.
  //! \param[in] len the length to set.
  //! \param[in] r   the radius to set.
  //! \param[in] cel the cross-edge length.
  asiAlgo_BlendChainProps(const double len,
                          const double r,
                          const double cel)
  : Length          (len),
    Radius          (r),
    CrossEdgeLength (cel)
  {}
};

#endif
