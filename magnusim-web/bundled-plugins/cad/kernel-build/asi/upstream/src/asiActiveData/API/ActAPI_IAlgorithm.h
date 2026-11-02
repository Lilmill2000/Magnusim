//-----------------------------------------------------------------------------
// Created on: April 2016
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

#ifndef ActAPI_IAlgorithm_HeaderFile
#define ActAPI_IAlgorithm_HeaderFile

// Active Data (API) includes
#include <ActAPI_INode.h>
#include <ActAPI_IPlotter.h>
#include <ActAPI_IProgressNotifier.h>

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Client code can subclass this abstract "drawer" base class to provide
//! specific drawing logic to an algorithm. Unlike "plotter", this one is
//! not limited to predefined types of entities and allows for more efficient
//! visualization if used properly. E.g., an algorithm may store its data in
//! a specific Data Node, which would need its own presentation logic. This
//! interface is designed for such "deep prototyping" use cases, see
//! https://quaoar.su/blog/page/two-ways-of-data-model-design.
//!
//! Some examples where we exploit custom visualization objects instead of
//! the besic IV entities include:
//!
//! - Drawing dimensioning for sheet metal (SMRU): `asiSheetMetal`.
//! - 3D nesting: `asiNesting`.
//! - Bending simulation for sheet metal (SMRU): `asiSheetMetal`.
class ActAPI_IDrawer : public Standard_Transient
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IDrawer, Standard_Transient)

public:

  //! Draws the passed Node. The default implementation does nothing.
  virtual void
    DrawNode(const Handle(ActAPI_INode)&) {}

};

//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Interface for algorithms.
class ActAPI_IAlgorithm : public Standard_Transient
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IAlgorithm, Standard_Transient)

public:

  ActData_EXPORT virtual
    ~ActAPI_IAlgorithm();

public:

  ActAPI_ProgressEntry& GetProgress() const { return m_progress; }
  ActAPI_PlotterEntry&  GetPlotter()  const { return m_plotter; }

  void SetProgress(ActAPI_ProgressEntry progress) { m_progress = progress; }
  void SetPlotter(ActAPI_PlotterEntry plotter) { m_plotter = plotter; }

public:

  //! Sets a custom drawer to the algorithm.
  //! \param[in] drawer the drawer to set.
  void SetDrawer(const Handle(ActAPI_IDrawer)& drawer)
  {
    m_drawer = drawer;
  }

  //! \return the used custom drawer.
  const Handle(ActAPI_IDrawer)& GetDrawer() const
  {
    return m_drawer;
  }

public:

  //! Sets status code as an integer.
  //! \param[in] status the code to set.
  void SetStatusFlags(const int status)
  {
    m_iStatusFlags = status;
  }

  //! \return integer status code.
  int GetStatusFlags() const
  {
    return m_iStatusFlags;
  }

  //! Adds a status to the currently stored one. The derived classes take
  //! responsibility to implement status codes as bitmasks like `0x01`, `0x02`,
  //! `0x04`, `0x08`, `0x10`, `0x20`, `0x40`, etc. This way, we can store several
  //! statuses in one integer variable.
  //! \param[in] statBit the status bit to add to the current status.
  void AddStatusFlag(const int statBit)
  {
    m_iStatusFlags |= statBit;
  }

  //! Checks whether the stored status code contains bits for the passed
  //! status.
  //! \param[in] statBit the bits to check.
  //! \return true/false.
  bool HasStatusFlag(const int statBit) const
  {
    return (m_iStatusFlags & statBit) > 0;
  }

protected:

  ActData_EXPORT
    ActAPI_IAlgorithm(ActAPI_ProgressEntry progress,
                      ActAPI_PlotterEntry  plotter);

protected:

  mutable ActAPI_ProgressEntry m_progress; //!< Progress Notifier.
  mutable ActAPI_PlotterEntry  m_plotter;  //!< Imperative Plotter.

  //! Drawer interface for advanced visual debugging.
  Handle(ActAPI_IDrawer) m_drawer;

  //! Status flags that can be an error code, warning code or any other
  //! status giving more detalisation on the algorithm's execution state.
  int m_iStatusFlags;

private:

  ActAPI_IAlgorithm() : Standard_Transient(), m_iStatusFlags(0) {} //!< Default ctor.

};

#endif
